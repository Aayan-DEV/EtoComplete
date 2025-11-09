FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV DJANGO_SETTINGS_MODULE=config.settings

WORKDIR /app

# Install dependencies first (better build cache)
COPY requirements.txt /app/
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir gunicorn

# Copy project files
COPY . /app

# Expose the app port
EXPOSE 8000

# Start Gunicorn; uses $PORT if provided (e.g., from hosting)
CMD ["bash", "-lc", "python manage.py collectstatic --noinput && gunicorn --bind 0.0.0.0:${PORT:-8000} config.wsgi:application"]