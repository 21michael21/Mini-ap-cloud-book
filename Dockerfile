FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml alembic.ini ./
COPY backend ./backend
COPY bot ./bot
COPY alembic ./alembic
COPY scripts ./scripts

RUN chmod +x scripts/railway_*.sh \
    && python -m pip install --upgrade pip \
    && python -m pip install -e .

COPY miniapp/package*.json ./miniapp/
RUN cd miniapp && npm ci

COPY miniapp ./miniapp
RUN cd miniapp && npm run build

CMD ["./scripts/railway_backend_start.sh"]
