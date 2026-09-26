/**
 * Python Production Dockerfile Generator (FastAPI, Flask, Django, Generic)
 * Slim Python 3.12 image supporting requirements.txt, pyproject.toml, and Pipfile.
 */
export function generatePythonDockerfile(metadata = {}) {
  const {
    framework = "Generic",
    port = 8000,
    startCommand,
  } = metadata;
  const frameworkKey = String(framework).toLowerCase();

  let defaultCmd = `python main.py`;
  if (frameworkKey === "fastapi") {
    defaultCmd = `uvicorn main:app --host 0.0.0.0 --port ${port}`;
  } else if (frameworkKey === "flask") {
    defaultCmd = `gunicorn --bind 0.0.0.0:${port} app:app`;
  } else if (frameworkKey === "django") {
    defaultCmd = `gunicorn app.wsgi:application --bind 0.0.0.0:${port}`;
  }

  const finalCmd = startCommand || defaultCmd;

  return `FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \\
    PYTHONDONTWRITEBYTECODE=1

# Install build dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends \\
    curl build-essential \\
    && rm -rf /var/lib/apt/lists/*

COPY requirements*.txt pyproject.toml* Pipfile* setup.py* ./

RUN if [ -f requirements.txt ]; then \\
      pip install --no-cache-dir -r requirements.txt; \\
    elif [ -f pyproject.toml ]; then \\
      pip install --no-cache-dir .; \\
    elif [ -f Pipfile ]; then \\
      pip install --no-cache-dir pipenv && pipenv install --system --deploy; \\
    fi

# Ensure production ASGI/WSGI servers are available if needed
RUN pip install --no-cache-dir uvicorn gunicorn || true

COPY . .

EXPOSE ${port || 8000}

CMD ["sh", "-c", "${finalCmd.replace(/"/g, '\\"')}"]
`;
}

export function generateFastApiDockerfile(metadata = {}) {
  return generatePythonDockerfile({ ...metadata, framework: "FastAPI", port: metadata.port || 8000 });
}

export function generateFlaskDockerfile(metadata = {}) {
  return generatePythonDockerfile({ ...metadata, framework: "Flask", port: metadata.port || 5000 });
}

export function generateDjangoDockerfile(metadata = {}) {
  return generatePythonDockerfile({ ...metadata, framework: "Django", port: metadata.port || 8000 });
}
