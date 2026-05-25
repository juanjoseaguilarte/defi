FROM node:20-slim

RUN apt-get update && apt-get install -y python3 python3-pip --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY python/requirements.txt python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

COPY . .

RUN mkdir -p /data
ENV DB_DIR=/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
