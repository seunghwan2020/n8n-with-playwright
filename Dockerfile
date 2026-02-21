FROM mcr.microsoft.com/playwright:v1.41.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
