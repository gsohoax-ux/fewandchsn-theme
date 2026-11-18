FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
VOLUME /app/data
EXPOSE 8080
CMD ["npm", "start"]
