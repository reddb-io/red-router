//! Kafka usage delivery with an address guard on every broker connection.
//!
//! `librdkafka` discovers brokers through cluster metadata. Validating only the
//! configured bootstrap hosts is therefore insufficient: an untrusted broker
//! could advertise a private or cloud-metadata address. The connect callback
//! below runs after DNS resolution and immediately before every socket connect,
//! including metadata-discovered brokers.

use rdkafka::{
    bindings as rdsys,
    client::{Client, ClientContext},
    config::ClientConfig,
    types::RDKafkaType,
};
use std::{
    ffi::{c_void, CString},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

const KAFKA_TIMEOUT_MS: i32 = 10_000;

#[cfg(windows)]
const SOCKET_AF_INET: libc::c_int = 2;
#[cfg(windows)]
const SOCKET_AF_INET6: libc::c_int = 23;
#[cfg(not(windows))]
const SOCKET_AF_INET: libc::c_int = libc::AF_INET;
#[cfg(not(windows))]
const SOCKET_AF_INET6: libc::c_int = libc::AF_INET6;

// POSIX and Winsock use these layouts for AF_INET/AF_INET6. Defining the
// wire-compatible prefix locally keeps the callback portable because `libc`
// intentionally does not expose `sockaddr_in{,6}` on Windows.
#[repr(C)]
#[derive(Clone, Copy)]
struct SocketAddressV4 {
    family: u16,
    port: u16,
    address: [u8; 4],
    zero: [u8; 8],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SocketAddressV6 {
    family: u16,
    port: u16,
    flow_info: u32,
    address: [u8; 16],
    scope_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaslMechanism {
    Plain,
    ScramSha256,
    ScramSha512,
}

impl SaslMechanism {
    pub(crate) fn parse(value: &str) -> Result<Option<Self>, &'static str> {
        match value {
            "" => Ok(None),
            "plain" => Ok(Some(Self::Plain)),
            "scram-sha-256" => Ok(Some(Self::ScramSha256)),
            "scram-sha-512" => Ok(Some(Self::ScramSha512)),
            _ => Err("invalid Kafka SASL mechanism"),
        }
    }

    fn librdkafka(self) -> &'static str {
        match self {
            Self::Plain => "PLAIN",
            Self::ScramSha256 => "SCRAM-SHA-256",
            Self::ScramSha512 => "SCRAM-SHA-512",
        }
    }
}

pub(crate) struct KafkaProducerConfig {
    pub brokers: Vec<String>,
    pub client_id: String,
    pub tls: bool,
    pub sasl: Option<SaslMechanism>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub allow_private: bool,
}

#[derive(Default)]
struct KafkaContext {
    allow_private: bool,
    blocked_address: AtomicBool,
    delivery_error: Mutex<Option<rdsys::rd_kafka_resp_err_t>>,
}

impl ClientContext for KafkaContext {}

pub(crate) struct GuardedKafkaProducer {
    client: Client<KafkaContext>,
    send_lock: Mutex<()>,
}

impl GuardedKafkaProducer {
    pub(crate) fn new(config: KafkaProducerConfig) -> Result<Self, &'static str> {
        validate_producer_config(&config)?;
        let mut client_config = ClientConfig::new();
        client_config
            .set("bootstrap.servers", config.brokers.join(","))
            .set("client.id", &config.client_id)
            .set("allow.auto.create.topics", "false")
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("message.send.max.retries", "2")
            .set("message.timeout.ms", KAFKA_TIMEOUT_MS.to_string())
            .set("socket.timeout.ms", KAFKA_TIMEOUT_MS.to_string())
            .set(
                "socket.connection.setup.timeout.ms",
                KAFKA_TIMEOUT_MS.to_string(),
            );
        match (config.tls, config.sasl) {
            (false, None) => {
                client_config.set("security.protocol", "plaintext");
            }
            (true, None) => {
                client_config.set("security.protocol", "ssl");
            }
            (false, Some(mechanism)) => {
                client_config
                    .set("security.protocol", "sasl_plaintext")
                    .set("sasl.mechanism", mechanism.librdkafka());
            }
            (true, Some(mechanism)) => {
                client_config
                    .set("security.protocol", "sasl_ssl")
                    .set("sasl.mechanism", mechanism.librdkafka());
            }
        }
        if config.sasl.is_some() {
            client_config
                .set(
                    "sasl.username",
                    config.username.as_deref().unwrap_or_default(),
                )
                .set(
                    "sasl.password",
                    config.password.as_deref().unwrap_or_default(),
                );
        }
        let native = client_config
            .create_native_config()
            .map_err(|_| "cannot configure Kafka producer")?;
        // SAFETY: both callbacks use the exact signatures required by
        // librdkafka. `Client::new` installs its owned `Arc<KafkaContext>` as
        // the opaque pointer before librdkafka can invoke either callback.
        unsafe {
            rdsys::rd_kafka_conf_set_connect_cb(native.ptr(), Some(guarded_connect));
            rdsys::rd_kafka_conf_set_dr_msg_cb(native.ptr(), Some(delivery_report));
        }
        let context = KafkaContext {
            allow_private: config.allow_private,
            ..KafkaContext::default()
        };
        let client = Client::new(
            &client_config,
            native,
            RDKafkaType::RD_KAFKA_PRODUCER,
            context,
        )
        .map_err(|_| "cannot initialize Kafka producer")?;
        Ok(Self {
            client,
            send_lock: Mutex::new(()),
        })
    }

    pub(crate) fn send(
        &self,
        topic: &str,
        key: &str,
        delivery_id: &str,
        payload: &[u8],
    ) -> Result<(), &'static str> {
        let _send = self
            .send_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        validate_topic(topic)?;
        if delivery_id.is_empty() || delivery_id.len() > 256 || delivery_id.bytes().any(|b| b == 0)
        {
            return Err("invalid Kafka delivery ID");
        }
        if payload.is_empty() || payload.len() > 10 * 1024 * 1024 {
            return Err("invalid Kafka usage payload");
        }
        let topic = CString::new(topic).map_err(|_| "invalid Kafka topic")?;
        let delivery_header = CString::new("redrouter-delivery-id").expect("static CString");
        let content_header = CString::new("content-type").expect("static CString");
        let content_type = b"application/json";
        self.client
            .context()
            .blocked_address
            .store(false, Ordering::Release);
        *self
            .client
            .context()
            .delivery_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let values = [
            kafka_cstr(
                rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_TOPIC,
                topic.as_ptr(),
            ),
            kafka_i32(rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_PARTITION, -1),
            kafka_mem(rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_VALUE, payload),
            kafka_mem(rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_KEY, key.as_bytes()),
            kafka_i32(
                rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_MSGFLAGS,
                rdsys::RD_KAFKA_MSG_F_COPY,
            ),
            kafka_header(delivery_header.as_ptr(), delivery_id.as_bytes()),
            kafka_header(content_header.as_ptr(), content_type),
            kafka_end(),
        ];
        // SAFETY: all pointers in `values` remain valid for the duration of
        // `produceva`; COPY makes librdkafka own its payload copy afterwards.
        let error = unsafe {
            rdsys::rd_kafka_produceva(self.client.native_ptr(), values.as_ptr(), values.len())
        };
        if !error.is_null() {
            // SAFETY: `produceva` returned an owned error object.
            unsafe { rdsys::rd_kafka_error_destroy(error) };
            return Err("Kafka rejected the usage message");
        }
        // SAFETY: the client remains alive and exclusively flushed by the
        // send lock. `flush` also serves the delivery callback.
        let flushed = unsafe { rdsys::rd_kafka_flush(self.client.native_ptr(), KAFKA_TIMEOUT_MS) };
        if self
            .client
            .context()
            .blocked_address
            .load(Ordering::Acquire)
        {
            return Err("Kafka broker address is blocked by the egress policy");
        }
        if flushed != rdsys::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
            return Err("Kafka usage delivery timed out");
        }
        let delivery_error = self
            .client
            .context()
            .delivery_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        match delivery_error {
            Some(error) if error != rdsys::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR => {
                Err("Kafka usage delivery failed")
            }
            _ => Ok(()),
        }
    }
}

fn validate_producer_config(config: &KafkaProducerConfig) -> Result<(), &'static str> {
    if config.brokers.is_empty() || config.brokers.len() > 20 {
        return Err("invalid Kafka brokers");
    }
    if config.client_id.is_empty()
        || config.client_id.len() > 128
        || !config
            .client_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("invalid Kafka client ID");
    }
    if config.sasl.is_some()
        && (config.username.as_deref().is_none_or(str::is_empty)
            || config.password.as_deref().is_none_or(str::is_empty))
    {
        return Err("Kafka SASL requires a username and password");
    }
    Ok(())
}

pub(crate) fn validate_topic(topic: &str) -> Result<(), &'static str> {
    if topic.is_empty()
        || topic.len() > 249
        || !topic
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("invalid Kafka topic");
    }
    Ok(())
}

pub(crate) fn broker_address_allowed(ip: IpAddr, allow_private: bool) -> bool {
    crate::allowed_address(ip, allow_private)
}

unsafe extern "C" fn guarded_connect(
    socket: libc::c_int,
    address: *const libc::sockaddr,
    address_len: libc::c_int,
    _broker_id: *const libc::c_char,
    opaque: *mut c_void,
) -> libc::c_int {
    if opaque.is_null() {
        return blocked_socket_error();
    }
    // SAFETY: `Client::new` stores a live `Arc<KafkaContext>` pointer as the
    // librdkafka opaque for the full callback lifetime.
    let context = unsafe { &*opaque.cast::<KafkaContext>() };
    let Some(ip) = (unsafe { socket_ip(address, address_len) }) else {
        context.blocked_address.store(true, Ordering::Release);
        return blocked_socket_error();
    };
    if !broker_address_allowed(ip, context.allow_private) {
        context.blocked_address.store(true, Ordering::Release);
        return blocked_socket_error();
    }
    // SAFETY: librdkafka owns the nonblocking socket and supplied a valid
    // sockaddr for the duration of this callback.
    let result = unsafe { platform_connect(socket, address, address_len) };
    if result == 0 {
        return 0;
    }
    let error = std::io::Error::last_os_error().raw_os_error().unwrap_or(1);
    if connect_in_progress(error) {
        0
    } else {
        error
    }
}

unsafe extern "C" fn delivery_report(
    _client: *mut rdsys::rd_kafka_t,
    message: *const rdsys::rd_kafka_message_t,
    opaque: *mut c_void,
) {
    if opaque.is_null() || message.is_null() {
        return;
    }
    // SAFETY: both pointers are owned by librdkafka and valid during the
    // callback. We copy only the error enum into Rust-owned state.
    let context = unsafe { &*opaque.cast::<KafkaContext>() };
    let error = unsafe { (*message).err };
    *context
        .delivery_error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
}

unsafe fn socket_ip(address: *const libc::sockaddr, length: libc::c_int) -> Option<IpAddr> {
    if address.is_null() || length < std::mem::size_of::<u16>() as libc::c_int {
        return None;
    }
    // SAFETY: caller guarantees the sockaddr is readable for `length` bytes.
    match unsafe { ptr::read_unaligned(address.cast::<u16>()) } as libc::c_int {
        SOCKET_AF_INET if length as usize >= std::mem::size_of::<SocketAddressV4>() => {
            // SAFETY: family and length identify a complete IPv4 sockaddr.
            let value = unsafe { ptr::read_unaligned(address.cast::<SocketAddressV4>()) };
            Some(IpAddr::V4(Ipv4Addr::from(value.address)))
        }
        SOCKET_AF_INET6 if length as usize >= std::mem::size_of::<SocketAddressV6>() => {
            // SAFETY: family and length identify a complete IPv6 sockaddr.
            let value = unsafe { ptr::read_unaligned(address.cast::<SocketAddressV6>()) };
            Some(IpAddr::V6(Ipv6Addr::from(value.address)))
        }
        _ => None,
    }
}

#[cfg(unix)]
unsafe fn platform_connect(
    socket: libc::c_int,
    address: *const libc::sockaddr,
    address_len: libc::c_int,
) -> libc::c_int {
    // SAFETY: forwarded unchanged from librdkafka's connect callback.
    unsafe { libc::connect(socket, address, address_len as libc::socklen_t) }
}

#[cfg(windows)]
unsafe fn platform_connect(
    socket: libc::c_int,
    address: *const libc::sockaddr,
    address_len: libc::c_int,
) -> libc::c_int {
    // SAFETY: forwarded unchanged from librdkafka's connect callback.
    unsafe { libc::connect(socket as libc::SOCKET, address, address_len) }
}

#[cfg(not(any(unix, windows)))]
unsafe fn platform_connect(
    _socket: libc::c_int,
    _address: *const libc::sockaddr,
    _address_len: libc::c_int,
) -> libc::c_int {
    -1
}

#[cfg(unix)]
fn connect_in_progress(error: i32) -> bool {
    error == libc::EINPROGRESS || error == libc::EWOULDBLOCK
}

#[cfg(windows)]
fn connect_in_progress(error: i32) -> bool {
    error == 10035
}

#[cfg(not(any(unix, windows)))]
fn connect_in_progress(_error: i32) -> bool {
    false
}

#[cfg(unix)]
fn blocked_socket_error() -> i32 {
    libc::EACCES
}

#[cfg(windows)]
fn blocked_socket_error() -> i32 {
    10013
}

#[cfg(not(any(unix, windows)))]
fn blocked_socket_error() -> i32 {
    1
}

fn kafka_cstr(vtype: rdsys::rd_kafka_vtype_t, value: *const libc::c_char) -> rdsys::rd_kafka_vu_t {
    rdsys::rd_kafka_vu_t {
        vtype,
        u: rdsys::rd_kafka_vu_s__bindgen_ty_1 { cstr: value },
    }
}

fn kafka_i32(vtype: rdsys::rd_kafka_vtype_t, value: i32) -> rdsys::rd_kafka_vu_t {
    rdsys::rd_kafka_vu_t {
        vtype,
        u: rdsys::rd_kafka_vu_s__bindgen_ty_1 { i32_: value },
    }
}

fn kafka_mem(vtype: rdsys::rd_kafka_vtype_t, value: &[u8]) -> rdsys::rd_kafka_vu_t {
    rdsys::rd_kafka_vu_t {
        vtype,
        u: rdsys::rd_kafka_vu_s__bindgen_ty_1 {
            mem: rdsys::rd_kafka_vu_s__bindgen_ty_1__bindgen_ty_1 {
                ptr: value.as_ptr().cast_mut().cast(),
                size: value.len(),
            },
        },
    }
}

fn kafka_header(name: *const libc::c_char, value: &[u8]) -> rdsys::rd_kafka_vu_t {
    rdsys::rd_kafka_vu_t {
        vtype: rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_HEADER,
        u: rdsys::rd_kafka_vu_s__bindgen_ty_1 {
            header: rdsys::rd_kafka_vu_s__bindgen_ty_1__bindgen_ty_2 {
                name,
                val: value.as_ptr().cast(),
                size: value.len() as isize,
            },
        },
    }
}

fn kafka_end() -> rdsys::rd_kafka_vu_t {
    rdsys::rd_kafka_vu_t {
        vtype: rdsys::rd_kafka_vtype_t::RD_KAFKA_VTYPE_END,
        u: rdsys::rd_kafka_vu_s__bindgen_ty_1 {
            ptr: ptr::null_mut(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_guard_blocks_metadata_and_private_addresses() {
        assert!(!broker_address_allowed(
            "169.254.169.254".parse().unwrap(),
            true
        ));
        assert!(!broker_address_allowed("127.0.0.1".parse().unwrap(), false));
        assert!(broker_address_allowed("127.0.0.1".parse().unwrap(), true));
        assert!(broker_address_allowed("1.1.1.1".parse().unwrap(), false));
    }

    #[test]
    fn kafka_names_and_sasl_are_strict() {
        assert!(validate_topic("redrouter.usage-v1").is_ok());
        assert!(validate_topic("bad/topic").is_err());
        assert_eq!(
            SaslMechanism::parse("scram-sha-512").unwrap(),
            Some(SaslMechanism::ScramSha512)
        );
        assert!(SaslMechanism::parse("oauthbearer").is_err());
    }
}
