/**
 * PHP Dockerfile generator (Laravel, Symfony, WordPress-style and plain PHP sites) on Apache.
 * The document root is public/ when the project has one, otherwise the repository root.
 */
export function generatePhpDockerfile(metadata = {}) {
  const { port = 8000, framework = "" } = metadata;
  const docRoot = metadata.docRoot ?? (String(framework).toLowerCase().includes("laravel") ? "public" : ".");
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8000;
  const root = /^[A-Za-z0-9_./-]*$/.test(String(docRoot ?? "")) && docRoot && docRoot !== "."
    ? `/var/www/html/${String(docRoot).replace(/^\.?\/*|\/+$/g, "")}`
    : "/var/www/html";

  return `FROM php:8.3-apache

RUN apt-get update && apt-get install -y --no-install-recommends \\
      git unzip libicu-dev libonig-dev libxml2-dev libzip-dev libpng-dev libpq-dev \\
    && docker-php-ext-install -j"$(nproc)" intl mbstring opcache pdo_mysql pdo_pgsql mysqli zip gd \\
    && a2enmod rewrite headers \\
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

WORKDIR /var/www/html

COPY . .

RUN if [ -f composer.json ]; then \\
      composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader --ignore-platform-reqs \\
      || composer update --no-dev --no-interaction --prefer-dist --ignore-platform-reqs; \\
    fi \\
    && if [ -f artisan ] && [ ! -f .env ] && [ -f .env.example ]; then cp .env.example .env && php artisan key:generate --force || true; fi \\
    && mkdir -p storage bootstrap/cache \\
    && chown -R www-data:www-data /var/www/html

RUN sed -ri 's/^Listen 80$/Listen ${runtimePort}/' /etc/apache2/ports.conf \\
    && printf '%s\\n' '<VirtualHost *:${runtimePort}>' \\
      '    DocumentRoot ${root}' \\
      '    <Directory ${root}>' \\
      '        AllowOverride All' \\
      '        Require all granted' \\
      '        DirectoryIndex index.php index.html' \\
      '    </Directory>' \\
      '</VirtualHost>' > /etc/apache2/sites-available/000-default.conf

EXPOSE ${runtimePort}

CMD ["apache2-foreground"]
`;
}
