FROM node:18-alpine

# Install LibreOffice
RUN apk add --no-cache libreoffice

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

EXPOSE 8000
CMD ["node", "index.js"]