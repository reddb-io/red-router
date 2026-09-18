# ☁️ Despliegue en la nube


---

## 🖥️ Despliegue en VPS

### Requisitos previos

- Ubuntu 20.04+ o distribución Linux similar
- Node.js 20+
- Git
- Acceso root o sudo

### Paso 1: Clonar el repositorio

```bash
git clone https://github.com/reddb-io/red-router.git
cd red-router/app
```

### Paso 2: Instalar dependencias

```bash
npm install
```

### Paso 3: Compilar la aplicación

```bash
npm run build
```

### Paso 4: Configurar variables de entorno

Crea un archivo `.env` o exporta variables:

```bash
export JWT_SECRET="your-secure-secret-change-this-to-random-string"
export INITIAL_PASSWORD="your-secure-password"
export DATA_DIR="/var/lib/red-router"
export NODE_ENV="production"
```

**Variables de entorno:**

| Variable | Por defecto | Descripción |
|----------|---------|-------------|
| `JWT_SECRET` | Auto-generado | **¡DEBE cambiarse en producción!** Usado para firmar tokens JWT |
| `INITIAL_PASSWORD` | `123456` | Contraseña de login del dashboard |
| `DATA_DIR` | `~/.red-router` | Ruta de almacenamiento de la base de datos |
| `NODE_ENV` | `development` | Establece a `production` para despliegue |
| `ENABLE_REQUEST_LOGS` | `false` | Habilita logs de debug de request/response |

### Paso 5: Crear el directorio de datos

```bash
sudo mkdir -p /var/lib/red-router
sudo chown $USER:$USER /var/lib/red-router
```

### Paso 6: Iniciar la aplicación

```bash
npm run start
```

### Paso 7: Configurar PM2 para producción

PM2 mantiene tu aplicación corriendo y la reinicia en caso de crash:

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar RedRouter con PM2
pm2 start npm --name red-router -- start

# Guardar la configuración de PM2
pm2 save

# Configurar PM2 para iniciar al arrancar el sistema
pm2 startup
# Sigue las instrucciones impresas por el comando anterior
```

**Comandos de gestión de PM2:**

```bash
# Ver logs
pm2 logs red-router

# Reiniciar aplicación
pm2 restart red-router

# Detener aplicación
pm2 stop red-router

# Ver estado
pm2 status

# Monitorear recursos
pm2 monit
```

---

## 🌐 Proxy reverso con Nginx

### ¿Por qué usar Nginx?

- Terminación SSL/TLS
- Mapeo de nombre de dominio
- Balanceo de carga
- Mejor seguridad

### Paso 1: Instalar Nginx

```bash
sudo apt update
sudo apt install nginx
```

### Paso 2: Configurar Nginx

Crea `/etc/nginx/sites-available/red-router`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL certificates (use certbot to generate)
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Proxy to RedRouter
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # SSE support - CRITICAL for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }

    # API endpoint
    location /v1 {
        proxy_pass http://localhost:25050;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # SSE support - CRITICAL for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

### Paso 3: Habilitar el sitio

```bash
# Crear enlace simbólico
sudo ln -s /etc/nginx/sites-available/red-router /etc/nginx/sites-enabled/

# Probar configuración
sudo nginx -t

# Recargar Nginx
sudo systemctl reload nginx
```

### Paso 4: Configurar SSL con Let's Encrypt

```bash
# Instalar certbot
sudo apt install certbot python3-certbot-nginx

# Obtener certificado SSL
sudo certbot --nginx -d your-domain.com

# La auto-renovación se configura automáticamente
# Probar renovación
sudo certbot renew --dry-run
```

---

## 🔒 Consideraciones de seguridad

### 1. Cambiar credenciales por defecto

**CRÍTICO:** Cambia `JWT_SECRET` y `INITIAL_PASSWORD` antes del despliegue:

```bash
# Generar JWT secret seguro
openssl rand -base64 32

# Usa este valor para JWT_SECRET
export JWT_SECRET="generated-secret-here"
```

### 2. Configuración del firewall

```bash
# Permitir SSH
sudo ufw allow 22/tcp

# Permitir HTTP/HTTPS (si usas Nginx)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Si NO usas proxy reverso, permite los puertos de RedRouter
sudo ufw allow 3000/tcp
sudo ufw allow 25050/tcp

# Habilitar firewall
sudo ufw enable
```

### 3. Restringir el acceso al dashboard

Si solo necesitas acceso por API, restringe el puerto del dashboard:

```bash
# Solo permitir acceso localhost al dashboard
sudo ufw deny 3000/tcp
```

Accede al dashboard vía túnel SSH:

```bash
ssh -L 3000:localhost:3000 user@your-server.com
# Luego abre http://localhost:3000 en tu navegador
```

### 4. Actualizaciones regulares

```bash
# Actualizar paquetes del sistema
sudo apt update && sudo apt upgrade -y

# Actualizar RedRouter
cd /path/to/red-router/app
git pull
npm install
npm run build
pm2 restart red-router
```

### 5. Estrategia de respaldo

```bash
# Respaldar el directorio de datos
tar -czf red-router-backup-$(date +%Y%m%d).tar.gz /var/lib/red-router

# Respaldo automatizado diario (agregar a crontab)
0 2 * * * tar -czf /backups/red-router-$(date +\%Y\%m\%d).tar.gz /var/lib/red-router
```

---

## 📊 Monitoreo

### Verificar el estado de la aplicación

```bash
# Estado PM2
pm2 status

# Ver logs
pm2 logs red-router --lines 100

# Monitorear recursos
pm2 monit
```

### Logs de Nginx

```bash
# Logs de acceso
sudo tail -f /var/log/nginx/access.log

# Logs de error
sudo tail -f /var/log/nginx/error.log
```

### Recursos del sistema

```bash
# Uso de CPU y memoria
htop

# Uso de disco
df -h

# Conexiones de red
netstat -tulpn | grep -E '3000|25050'
```

---

## 🚨 Solución de problemas

### La aplicación no inicia

```bash
# Verificar logs
pm2 logs red-router

# Verificar si los puertos están en uso
sudo lsof -i :3000
sudo lsof -i :25050

# Verificar variables de entorno
pm2 env red-router
```

### Nginx 502 Bad Gateway

```bash
# Verificar si RedRouter está corriendo
pm2 status

# Verificar logs de error de Nginx
sudo tail -f /var/log/nginx/error.log

# Probar configuración de Nginx
sudo nginx -t
```

### El streaming SSE no funciona

Asegúrate de que `proxy_buffering off` esté configurado en Nginx para soporte SSE.

### Errores de permiso denegado

```bash
# Corregir permisos del directorio de datos
sudo chown -R $USER:$USER /var/lib/red-router
chmod 755 /var/lib/red-router
```

---

## 🔗 Próximos pasos

- [Conectar proveedores](/providers/subscription.md)
- [Configurar combos](/features/combos.md)
- [Integrar con herramientas](/integration/cursor.md)
