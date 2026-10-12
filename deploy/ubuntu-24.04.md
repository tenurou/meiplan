# Развёртывание на Ubuntu 24.04 LTS

Инструкция поднимает приложение на `meiplan.ru` с отдельными учётными записями сотрудников. Node.js слушает только loopback, а внешний HTTPS завершается на nginx. DNS A-запись домена должна указывать на VPS `151.248.116.100`; не публикуй порт `8765` в firewall.

## Установка

Скопируй исходники приложения в `/opt/agm-plan-assistant`, исключив каталоги `data/`, `node_modules/`, `.git/` и локальные cache/browser-профили. Не переноси файлы с рабочими cookies или локальными учётными данными. Затем выполни:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg nginx python3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # должно быть v20 или новее
python3 --version
sudo adduser --system --group --home /var/lib/agm-plan-assistant agmapp
sudo chown -R agmapp:agmapp /opt/agm-plan-assistant
sudo -u agmapp -H bash -lc 'cd /opt/agm-plan-assistant && npm ci --omit=dev --no-audit --no-fund'
sudo chown -R root:root /opt/agm-plan-assistant
sudo /opt/agm-plan-assistant/node_modules/.bin/playwright install-deps chromium
sudo install -d -o agmapp -g agmapp -m 0700 /var/lib/agm-plan-assistant/ms-playwright
sudo -u agmapp -H env PLAYWRIGHT_BROWSERS_PATH=/var/lib/agm-plan-assistant/ms-playwright \
  /usr/bin/node /opt/agm-plan-assistant/node_modules/playwright/cli.js install chromium
sudo install -d -o agmapp -g agmapp -m 0700 /var/lib/agm-plan-assistant/data
```

Исходники и зависимости после установки остаются только для чтения сервисом; записи приложения идут в отдельный `/var/lib/agm-plan-assistant`.

Если Playwright CLI расположен иначе, найди его через `readlink -f /opt/agm-plan-assistant/node_modules/.bin/playwright` и подставь путь к `cli.js`.

## Авторизация и HTTPS

Для HTTPS используется домен `meiplan.ru`. Установи Certbot из snap и проверь, что DNS A-запись уже разрешается в `151.248.116.100` извне.

```bash
sudo apt install -y snapd
sudo snap install --classic certbot
sudo ln -sfn /snap/bin/certbot /usr/local/bin/certbot
snap list certbot
```

До выпуска сертификата включи временный HTTP-only nginx vhost для IP: обработчик `location /.well-known/acme-challenge/ { root /var/www/html; }`, для всех остальных URL — `return 404;`. Создай webroot и открой порт 80 в firewall REG.RU и UFW. Затем запроси сертификат:

```bash
sudo install -d -m 0755 /var/www/html/.well-known/acme-challenge
sudo certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot -w /var/www/html -d meiplan.ru --cert-name meiplan.ru
```

После успешной выдачи установи финальный `deploy/nginx.conf.example` в `/etc/nginx/sites-available/agm-plan-assistant`; он настроен на этот IP, сертификат и ключ Let's Encrypt. Установи deploy-hook для перечитывания TLS-файлов nginx после каждого продления и проверь расписание обновления:

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx >/dev/null <<'HOOK'
#!/bin/sh
set -eu
systemctl reload nginx
HOOK
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo ln -s /etc/nginx/sites-available/agm-plan-assistant /etc/nginx/sites-enabled/agm-plan-assistant
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl enable --now snap.certbot.renew.timer
sudo systemctl list-timers snap.certbot.renew.timer
sudo certbot renew --dry-run
```

Не оставляй приложение доступным по HTTP: порт 80 отдаёт только ACME challenge и перенаправляет остальные запросы на HTTPS.

Пример переменных для `/etc/agm-plan-assistant.env`:

```ini
AGM_HOST=127.0.0.1
AGM_PORT=8765
AGM_DATA_DIR=/var/lib/agm-plan-assistant/data
AGM_USERS_FILE=/var/lib/agm-plan-assistant/data/users.json
AGM_ALLOWED_HOSTS=meiplan.ru
AGM_PUBLIC_ORIGIN=https://meiplan.ru
AGM_MAX_BROWSERS=18
AGM_IDLE_BROWSER_MINUTES=60
PLAYWRIGHT_BROWSERS_PATH=/var/lib/agm-plan-assistant/ms-playwright
```

Создай файл с доступом только root и сервисной учётной записи, затем добавь пользователя интерактивно (пароли вводятся без эха и не попадают в аргументы процесса):

```bash
sudo install -o root -g agmapp -m 0640 /dev/null /etc/agm-plan-assistant.env
sudoedit /etc/agm-plan-assistant.env
sudo -u agmapp env AGM_USERS_FILE=/var/lib/agm-plan-assistant/data/users.json \
  /usr/bin/node /opt/agm-plan-assistant/scripts/users.mjs add admin --admin
```

Сотрудникам отдельные логины не нужны: приложение выдаёт каждому браузеру независимую защищённую cookie-сессию. Администратор входит отдельно через кнопку панели внизу сайта; доступ к обращениям ограничен ролью на сервере. Приложение хранит только соль и хэш пароля; изменения списка администраторов применяются после перезапуска сервера.

## systemd

Скопируй `deploy/agm-plan-assistant.service` в `/etc/systemd/system/agm-plan-assistant.service`, затем:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agm-plan-assistant
sudo systemctl status agm-plan-assistant
```

## nginx и TLS

Финальный nginx-конфиг проксирует приложение через loopback и включает только HTTPS для интерфейса. В конфигурации Node разрешены только хост из `AGM_ALLOWED_HOSTS` и origin `AGM_PUBLIC_ORIGIN`. Таймер Certbot регулярно продлевает сертификат, а deploy-hook перечитывает TLS-файлы nginx.

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

Не открывай `8765/tcp`; nginx проксирует его через `127.0.0.1`.

## Проверка

Из каталога проекта под сервисным пользователем выполни тесты. Они не обращаются к Core:

```bash
sudo -u agmapp -H bash -lc 'cd /opt/agm-plan-assistant && npm test'
sudo -u agmapp -H bash -lc 'cd /opt/agm-plan-assistant && npm run measure:resources'
curl -I https://meiplan.ru/
```

Тесты проверяют автономный Chromium и DOM-взаимодействие, Excel-парсер, авторизацию, запуск сервера, изоляцию файлов пользователей, форму обратной связи и полные потоки Excel→Core и DataLens→Core (предпросмотр, запись, повторное чтение) на локальных фикстурах. После установки зависимостей можно отдельно проверить запуск веб-сервера на loopback без Core/DataLens: `node scripts/smoke-server.mjs`. Замер ресурсов выводит RSS дерева Chromium и примерную загрузку CPU при 1, 2 и 3 одновременных браузерах. Запусти замер на целевом VPS: показатели зависят от его CPU, RAM и текущей нагрузки.
