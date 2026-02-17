FROM node:18-slim

# Define o diretório de trabalho
WORKDIR /app

# Copia o package.json
COPY package.json ./

# Instala as dependências (gera o lockfile internamente)
RUN npm install

# Copia o código fonte
COPY . .

# Expõe a porta
EXPOSE 8000

# Comando de inicialização
CMD [ "node", "server.js" ]
