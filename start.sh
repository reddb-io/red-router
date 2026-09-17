docker stop red-router
docker rm red-router
docker build -t red-router .
docker run -d --name red-router -p 20128:20128 --env-file .env -v red-router-data:/app/data red-router