FROM node:26-alpine
WORKDIR /app
COPY package.json server.js index.html employee-hiring-joining-form.html monument-skyline.png ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=3000 HOST=0.0.0.0 DATABASE_PATH=/app/data/employee-dashboard.sqlite
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]

