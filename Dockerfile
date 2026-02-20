FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev

COPY server.js /app/server.js

ENV TZ=Asia/Seoul
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
