# Local stand-in for Aurora in services/realtime-aurora/test/local-delivery.sh
# (VTID-05023, plan part 7a): Postgres with logical decoding, the wal2json
# output plugin Realtime's postgres_cdc_rls uses (Aurora ships it), TLS on and
# password logins only over TLS (as rds.force_ssl=1 would enforce).
ARG PG_IMAGE=postgres:17
FROM ${PG_IMAGE}
# extra-ca.crt is empty unless the build runs behind a TLS-intercepting proxy
# (then apt talks https through it and trusts only that CA).
COPY extra-ca.crt /tmp/extra-ca.crt
RUN set -eux; \
    if [ -s /tmp/extra-ca.crt ]; then \
      echo 'Acquire::https::CAInfo "/tmp/extra-ca.crt";' > /etc/apt/apt.conf.d/99extra-ca; \
      sed -i 's#http://#https://#g' /etc/apt/sources.list.d/* /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-wal2json"; \
    rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99extra-ca /tmp/extra-ca.crt; \
    install -d -o postgres -g postgres -m 755 /etc/pg-test
COPY --chown=postgres:postgres --chmod=600 server.key /etc/pg-test/server.key
COPY --chown=postgres:postgres --chmod=644 server.crt /etc/pg-test/server.crt
COPY --chown=postgres:postgres --chmod=644 pg_hba.conf /etc/pg-test/pg_hba.conf
