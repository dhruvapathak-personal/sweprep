# Interactive Dev Container; the offline runner uses a separate Containerfile.
FROM docker.io/library/ubuntu:26.04
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git openssh-client bash ca-certificates curl \
    gnupg jq bubblewrap socat slirp4netns iptables \
    sudo python3 python3-venv podman-remote \
    && ln -s /usr/bin/podman-remote /usr/local/bin/podman \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    -o /tmp/nodesource-repo.gpg.key \
    && gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg /tmp/nodesource-repo.gpg.key \
    && rm /tmp/nodesource-repo.gpg.key \
    && printf '%s\n' \
    'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' \
    > /etc/apt/sources.list.d/nodesource.list
# Install node.js and npm
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.19.1
# Create and configure the dhruva user with sudo privileges
RUN if id ubuntu >/dev/null 2>&1; then \
    groupmod --new-name dhruva ubuntu \
    && usermod --login dhruva --home /home/dhruva --move-home --shell /bin/bash ubuntu; \
    else \
    groupadd --gid 1000 dhruva \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash dhruva; \
    fi \
    && test "$(id -u dhruva)" = 1000 \
    && test "$(id -g dhruva)" = 1000
# Fresh named volumes inherit ownership from their image mountpoints.
RUN install -d -m 0755 -o dhruva -g dhruva \
    /home/dhruva/.vscode-server \
    /home/dhruva/.copilot \
    /home/dhruva/.codex
RUN printf '%s\n' 'dhruva ALL=(ALL:ALL) NOPASSWD: ALL' \
    > /etc/sudoers.d/dhruva \
    && chmod 0440 /etc/sudoers.d/dhruva \
    && visudo -cf /etc/sudoers
USER dhruva
ENV HOME=/home/dhruva
# Install pixi for the container user
ENV PATH="/home/dhruva/.pixi/bin:${PATH}"
RUN curl -fsSL https://pixi.sh/install.sh | PIXI_NO_TELEMETRY=1 sh
WORKDIR /workspace
RUN node --version && npm --version && python3 --version && pixi --version \
    && podman --version
CMD ["sleep", "infinity"]
