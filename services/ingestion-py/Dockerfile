FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml GEMINI.md ./
RUN cp GEMINI.md README.md
COPY src/ ./src/
COPY models/ ./models/
COPY generated/ ./generated/

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir hatchling && \
    pip install --no-cache-dir .

EXPOSE 8001

CMD ["uvicorn", "src.ingestion.main:app", "--host", "0.0.0.0", "--port", "8001"]
