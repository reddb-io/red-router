"""Minimal StatusNotifierWatcher for the real Linux tray CI regression."""
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName("org.kde.StatusNotifierWatcher", bus)


class Watcher(dbus.service.Object):
    def __init__(self):
        super().__init__(bus, "/StatusNotifierWatcher")
        self.items = []
        bus.add_signal_receiver(self.owner_changed, signal_name="NameOwnerChanged",
                                dbus_interface="org.freedesktop.DBus")

    def owner_changed(self, service, previous, current):
        if not current:
            self.items = [item for item in self.items if item.split("@")[0] != service]

    @dbus.service.method("org.kde.StatusNotifierWatcher", in_signature="s", out_signature="",
                         sender_keyword="sender")
    def RegisterStatusNotifierItem(self, service, sender=None):
        item = f"{sender}@{service}" if service.startswith("/") else str(service)
        if item not in self.items:
            self.items.append(item)
            self.StatusNotifierItemRegistered(item)

    @dbus.service.method("org.kde.StatusNotifierWatcher", in_signature="s", out_signature="")
    def RegisterStatusNotifierHost(self, service):
        pass

    @dbus.service.signal("org.kde.StatusNotifierWatcher", signature="s")
    def StatusNotifierItemRegistered(self, item):
        pass

    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        if prop == "RegisteredStatusNotifierItems":
            return dbus.Array(self.items, signature="s")
        if prop == "IsStatusNotifierHostRegistered":
            return dbus.Boolean(True)
        if prop == "ProtocolVersion":
            return dbus.Int32(0)
        raise dbus.exceptions.DBusException("Unknown property")

    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return {prop: self.Get(interface, prop) for prop in ["RegisteredStatusNotifierItems",
                                                          "IsStatusNotifierHostRegistered",
                                                          "ProtocolVersion"]}


watcher = Watcher()
print("watcher ready", flush=True)
GLib.MainLoop().run()
