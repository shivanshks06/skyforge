export function generatePhpDockerfile(metadata = {}) {
  const { port = 8000 } = metadata;
  const runtimePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : 8000;

  return `FROM php:8.3-apache

RUN apt-get update && apt-get install -y --no-install-recommends \\
      git unzip libicu-dev libonig-dev libxml2-dev libzip-dev \\
    && docker-php-ext-install -j"$(nproc)" intl mbstring opcache pdo_mysql zip \\
    && a2enmod rewrite headers \\
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

WORKDIR /var/www/html

COPY . .

RUN if [ -f composer.json ]; then \\
      composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader; \\
    fi

RUN mkdir -p public storage bootstrap/cache \\
    && chown -R www-data:www-data storage bootstrap/cache \\
    && printf 'Listen ${runtimePort}\\n' >> /etc/apache2/ports.conf \\
    && cat > /etc/apache2/sites-available/000-default.conf <<'APACHE'
<VirtualHost *:${runtimePort}>
    DocumentRoot /var/www/html/public
    <Directory /var/www/html/public>
        AllowOverride All
        Require all granted
    </Directory>
    ErrorLog \${APACHE_LOG_DIR}/error.log
    CustomLog \${APACHE_LOG_DIR}/access.log combined
</VirtualHost>
APACHE

EXPOSE ${runtimePort}

CMD ["apache2-foreground"]
`;
}
