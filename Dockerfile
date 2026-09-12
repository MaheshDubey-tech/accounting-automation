FROM node:18-alpine

WORKDIR /app

# Install build dependencies if needed
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production || npm install --production

COPY . .

EXPOSE 5001

ENV NODE_ENV=production
ENV PORT=5001

CMD ["npm", "start"]
