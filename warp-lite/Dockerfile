# ==========================================
# Stage 1: Build microsocks (pure C SOCKS5)
# ==========================================
FROM alpine:3.21 AS microsocks-builder

RUN apk add --no-cache build-base git

ARG MICROSOCKS_REF=master
RUN git clone --depth 1 --branch "${MICROSOCKS_REF}" \
    https://github.com/rofl0r/microsocks.git /src \
    && make -C /src

# ==========================================
# Stage 2: Minimal runtime (WireGuard only)
# ==========================================
FROM alpine:3.21

# wireguard-tools: wg-quick + wg
# iptables: both iptables and ip6tables on Alpine
# iproute2: ip rule/route for policy routing
# curl + ca-certificates: wgcf bootstrap + HTTPS trace probes
# openresolv: satisfies resolvconf calls from wg-quick code paths
RUN apk add --no-cache \
    wireguard-tools \
    iptables \
    iproute2 \
    curl \
    ca-certificates \
    openresolv \
    && update-ca-certificates \
    && rm -rf /var/cache/apk/*

COPY --from=microsocks-builder /src/microsocks /usr/local/bin/microsocks

WORKDIR /app
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh \
    && mkdir -p /etc/wireguard

EXPOSE 1080/tcp
# WireGuard profile persists here across restarts (tier-1/tier-2 rotation).
VOLUME ["/etc/wireguard"]

CMD ["./entrypoint.sh"]
