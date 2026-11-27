# Frontend PrazoAI (Next.js). O MODO é fixado no BUILD (NEXT_PUBLIC_PRAZOAI_MODE):
#   demo (padrão)  → protótipo público, sem BFF, sem segredos;
#   integrated     → BFF + FastAPI; segredos do BFF vêm do ambiente em EXECUÇÃO (nunca no build).
# Ex.: docker build --build-arg NEXT_PUBLIC_PRAZOAI_MODE=integrated -t prazoai-frontend .
FROM node:22-alpine
ARG NEXT_PUBLIC_PRAZOAI_MODE=demo
ENV NEXT_PUBLIC_PRAZOAI_MODE=$NEXT_PUBLIC_PRAZOAI_MODE \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: nenhum script de instalação de pacote de terceiros roda no build.
RUN npm ci --ignore-scripts
# Só o necessário para o build, arquivo por arquivo (nada de `COPY . .`: nenhum arquivo local, .env ou
# segredo esquecido na pasta entra na imagem).
COPY next.config.ts tsconfig.json next-env.d.ts postcss.config.mjs eslint.config.mjs ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build && chown -R node:node /app
USER node
EXPOSE 3000
# PORT é definido por muitas plataformas; 3000 por padrão.
CMD ["sh", "-c", "exec npx next start -p ${PORT:-3000}"]
