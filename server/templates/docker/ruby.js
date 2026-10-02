/**
 * Jekyll (GitHub Pages) generator: builds the site once with Ruby and serves _site with Nginx.
 */
export function generateJekyllDockerfile(metadata = {}) {
  const { rubyVersion = "3.3" } = metadata;
  return `FROM ruby:${rubyVersion}-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends build-essential git \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /site

COPY . .

ENV JEKYLL_ENV=production

RUN if [ -f Gemfile ]; then \\
      (bundle install || (rm -f Gemfile.lock && bundle install)) && bundle exec jekyll build -d /out; \\
    else \\
      gem install jekyll bundler && jekyll build -d /out; \\
    fi

FROM nginx:alpine

RUN printf '%s\\n' 'server {' \\
    '    listen 80;' \\
    '    server_name _;' \\
    '    root /usr/share/nginx/html;' \\
    '    index index.html;' \\
    '    location / { try_files $uri $uri/ $uri.html =404; }' \\
    '}' > /etc/nginx/conf.d/default.conf

COPY --from=builder /out /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
}

/**
 * Ruby Dockerfile generator (Rails, Sinatra, any Rack app).
 * Rails runs in production with a generated SECRET_KEY_BASE and serves its own static files.
 */
export function generateRubyDockerfile(metadata = {}) {
  const { port = 3000, startCommand, framework = "Ruby", rubyVersion = "3.3" } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 3000;
  const rails = String(framework).toLowerCase().includes("rails");
  const defaultStart = rails
    ? `bundle exec rails db:prepare 2>/dev/null || true; exec bundle exec rails server -b 0.0.0.0 -p ${runtimePort}`
    : `exec bundle exec rackup -o 0.0.0.0 -p ${runtimePort}`;
  const finalCmd = startCommand || defaultStart;

  return `FROM ruby:${rubyVersion}-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
      build-essential git libpq-dev libsqlite3-dev libyaml-dev nodejs npm curl \\
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV RAILS_ENV=production \\
    RACK_ENV=production \\
    RAILS_SERVE_STATIC_FILES=1 \\
    RAILS_LOG_TO_STDOUT=1 \\
    BUNDLE_WITHOUT="development:test" \\
    PORT=${runtimePort}

COPY . .

RUN gem install bundler --conservative && (bundle install || (bundle lock --update && bundle install))
${rails ? `
RUN SECRET_KEY_BASE=placeholder bundle exec rails assets:precompile 2>/dev/null || true
` : ""}
EXPOSE ${runtimePort}

CMD ["sh", "-c", "export SECRET_KEY_BASE=\${SECRET_KEY_BASE:-$(head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \\\\n')}; ${finalCmd.replace(/"/g, '\\"')}"]
`;
}
