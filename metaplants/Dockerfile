FROM node:18-alpine

# Imposta la cartella di lavoro
WORKDIR /usr/src/app

# Copia i file del package e installa
COPY app/package*.json ./
RUN npm install

# Copia il resto del codice
COPY app/ .

# Espone la porta (deve coincidere con ingress_port)
EXPOSE 3000

# Avvia l'app
CMD [ "node", "server.js" ]