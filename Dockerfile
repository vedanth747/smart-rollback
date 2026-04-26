FROM node:18-alpine

WORKDIR /app

COPY . .

ENV NODE_ENV=production
ARG APP_FILE=app_v2.js
ENV APP_FILE=${APP_FILE}

EXPOSE 3000

CMD ["sh", "-c", "node $APP_FILE"]