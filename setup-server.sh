#!/usr/bin/env bash
# 一次性服务器配置脚本：把 WebAIGame 注册为 systemd 服务 webaigame。
# 用法：sudo bash setup-server.sh /home/ubuntu/WebAIGame
set -euo pipefail

APP_DIR="${1:-/home/ubuntu/WebAIGame}"
SERVICE_NAME="webaigame"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_DIR="/etc/webaigame"
ENV_FILE="${ENV_DIR}/${SERVICE_NAME}.env"
PORT="${WEB_AI_GAME_PORT:-8000}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 sudo 运行：sudo bash setup-server.sh ${APP_DIR}"
  exit 1
fi
if [[ -z "${APP_DIR}" || "${APP_DIR}" == "/" ]]; then
  echo "错误：APP_DIR 不能为 / 或空。"
  exit 1
fi
if [[ ! -f "${APP_DIR}/dev-server.cjs" ]]; then
  echo "错误：${APP_DIR}/dev-server.cjs 不存在。请先上传 WebAIGame 项目。"
  exit 1
fi

APP_USER="${SUDO_USER:-ubuntu}"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 未安装，正在安装 Node.js 20 LTS ..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "==> Node：${NODE_BIN} ($(node -v))"

echo "==> 清理旧/放错位置的服务文件"
sudo rm -f "${SERVICE_FILE}"
if [[ -d /etc/WebAIGame ]]; then
  sudo rm -rf /etc/WebAIGame
fi

echo "==> 写环境文件 ${ENV_FILE}"
sudo mkdir -p "${ENV_DIR}"
if [[ ! -f "${ENV_FILE}" ]]; then
  sudo tee "${ENV_FILE}" >/dev/null <<ENV
WEB_AI_GAME_HOST=0.0.0.0
WEB_AI_GAME_PORT=${PORT}
ENV
  sudo chmod 600 "${ENV_FILE}"
else
  echo "    已存在，保留现有配置。"
fi

echo "==> 写服务 ${SERVICE_FILE}"
sudo tee "${SERVICE_FILE}" >/dev/null <<SERVICE
[Unit]
Description=TianXiaYingXiongSha WebAIGame server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} ${APP_DIR}/dev-server.cjs
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

echo "==> 校验文件落位"
ls -l "${SERVICE_FILE}" "${ENV_FILE}"

echo "==> 注册并启动"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"
sleep 1
sudo systemctl --no-pager status "${SERVICE_NAME}"

echo
echo "监听 http://0.0.0.0:${PORT}/，检查：ss -tlnp | grep ${PORT}"
echo "日常：sudo systemctl start/stop/restart/status webaigame"
echo "更新：重传 ${APP_DIR} 后执行 sudo systemctl restart webaigame"
