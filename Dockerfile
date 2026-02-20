FROM mcr.microsoft.com/playwright:v1.49.0-jammy

RUN npm install -g n8n

ENV N8N_PORT=5678
EXPOSE 5678

CMD ["n8n", "start"]
