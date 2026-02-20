FROM mcr.microsoft.com/playwright:v1.49.0-jammy

USER root

# Node 20.19+로 올리기 (NodeSource)
RUN apt-get update \
  && apt-get install -y curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && node -v

RUN npm install -g n8n

ENV N8N_PORT=5678
EXPOSE 5678

CMD ["n8n", "start"]
