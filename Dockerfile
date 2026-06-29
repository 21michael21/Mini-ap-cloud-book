FROM node:22.12-slim AS miniapp-build

WORKDIR /app/miniapp

COPY miniapp/package*.json ./
COPY miniapp/scripts ./scripts
RUN npm ci

COPY miniapp ./
RUN npm run build


FROM python:3.12-slim

ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG APP_ENV=production

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_TIME=${BUILD_TIME} \
    APP_ENV=${APP_ENV}

WORKDIR /app

COPY pyproject.toml alembic.ini ./
COPY backend ./backend
COPY bot ./bot
COPY alembic ./alembic
COPY scripts ./scripts

RUN chmod +x scripts/railway_*.sh \
    && python -m pip install --upgrade pip \
    && python -m pip install -e .

COPY --from=miniapp-build /app/miniapp/dist ./miniapp/dist

CMD ["./scripts/railway_backend_start.sh"]
