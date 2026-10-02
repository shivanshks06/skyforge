/**
 * Python Dockerfile generator (Django, Flask, FastAPI, Streamlit, generic scripts).
 * Installs from requirements*.txt, pyproject.toml, or Pipfile; the build planner supplies the
 * start command it resolved from the source (WSGI/ASGI module, app object, entry script).
 */
const DEFAULT_COMMANDS = {
  // Discover the project package that holds wsgi.py at runtime when no command was resolved.
  django: (port) => `python manage.py migrate --noinput || true; MOD="$(dirname "$(ls */wsgi.py | head -n 1)")"; exec gunicorn "$MOD.wsgi:application" --bind 0.0.0.0:${port} --workers 2 --timeout 120`,
  flask: (port) => `exec gunicorn --bind 0.0.0.0:${port} --workers 2 --timeout 120 app:app`,
  fastapi: (port) => `exec uvicorn main:app --host 0.0.0.0 --port ${port}`,
};

export function generatePythonDockerfile(metadata = {}) {
  const {
    framework = "Generic",
    port = 8000,
    startCommand,
    pythonVersion = "3.12",
    buildCommand = "",
  } = metadata;
  const frameworkKey = String(framework).toLowerCase();
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8000;
  const finalCmd = startCommand || DEFAULT_COMMANDS[frameworkKey]?.(runtimePort) || "python main.py";
  // Django repos without a dependency manifest still need Django itself to boot.
  const fallbackInstall = frameworkKey === "django" ? "pip install --no-cache-dir django" : "true";
  const buildStep = buildCommand ? `\nRUN ${buildCommand} || true\n` : "";

  return `FROM python:${pythonVersion}-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \\
    PYTHONDONTWRITEBYTECODE=1 \\
    PIP_DISABLE_PIP_VERSION_CHECK=1 \\
    PORT=${runtimePort} \\
    HOST=0.0.0.0 \\
    DJANGO_ALLOWED_HOSTS="*" \\
    ALLOWED_HOSTS="*"

COPY . .

# Install from prebuilt wheels first; compilers and database headers (~250 MB) are only
# fetched when a dependency has to be built from source.
RUN install_deps() { \\
      if [ -f requirements.txt ]; then \\
        pip install --no-cache-dir -r requirements.txt; \\
      elif ls requirements/*.txt >/dev/null 2>&1; then \\
        pip install --no-cache-dir -r "$(ls requirements/prod*.txt requirements/base.txt requirements/*.txt 2>/dev/null | head -n 1)"; \\
      elif [ -f pyproject.toml ]; then \\
        (pip install --no-cache-dir uv && uv pip install --system -r pyproject.toml) \\
        || pip install --no-cache-dir . \\
        || (pip install --no-cache-dir poetry && poetry config virtualenvs.create false && poetry install --no-root --only main); \\
      elif [ -f Pipfile ]; then \\
        pip install --no-cache-dir pipenv && (pipenv install --system --deploy --ignore-pipfile || pipenv install --system --skip-lock); \\
      else \\
        ${fallbackInstall}; \\
      fi; \\
    }; \\
    install_deps || ( \\
      apt-get update && apt-get install -y --no-install-recommends \\
        build-essential libpq-dev default-libmysqlclient-dev libffi-dev pkg-config \\
      && rm -rf /var/lib/apt/lists/* && install_deps )

# Production servers for WSGI/ASGI apps.
RUN pip install --no-cache-dir gunicorn uvicorn
${buildStep}
EXPOSE ${runtimePort}

CMD ["sh", "-c", "${finalCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]
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
