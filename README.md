```dockerfile
FROM amazonlinux:2023

ARG AIRFLOW_VERSION=3.1.8
ARG PYTHON_VERSION=3.13
ARG PYTHON_FULL_VERSION=3.13.1
ARG AIRFLOW_HOME=/opt/airflow
ARG AIRFLOW_USER=airflow

ENV AIRFLOW_HOME=${AIRFLOW_HOME} \
    PATH="/usr/local/bin:${PATH}" \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build deps for CPython + common Airflow C extensions
RUN dnf -y update && \
    dnf -y groupinstall "Development Tools" && \
    dnf -y install \
        gcc gcc-c++ make \
        openssl-devel bzip2-devel libffi-devel zlib-devel \
        xz-devel ncurses-devel readline-devel sqlite-devel \
        tk-devel gdbm-devel \
        libpq-devel \
        tar gzip wget which shadow-utils \
        krb5-devel cyrus-sasl-devel libxml2-devel libxslt-devel && \
    dnf clean all

# Build Python 3.13 from source
RUN cd /tmp && \
    wget -q https://www.python.org/ftp/python/${PYTHON_FULL_VERSION}/Python-${PYTHON_FULL_VERSION}.tgz && \
    tar xzf Python-${PYTHON_FULL_VERSION}.tgz && \
    cd Python-${PYTHON_FULL_VERSION} && \
    ./configure --enable-optimizations --enable-shared \
                --with-system-ffi LDFLAGS="-Wl,-rpath=/usr/local/lib" && \
    make -j"$(nproc)" && \
    make altinstall && \
    ln -sf /usr/local/bin/python${PYTHON_VERSION} /usr/local/bin/python3 && \
    ln -sf /usr/local/bin/python${PYTHON_VERSION} /usr/local/bin/python && \
    ln -sf /usr/local/bin/pip${PYTHON_VERSION} /usr/local/bin/pip3 && \
    ln -sf /usr/local/bin/pip${PYTHON_VERSION} /usr/local/bin/pip && \
    cd / && rm -rf /tmp/Python-${PYTHON_FULL_VERSION}*

# Create airflow user
RUN useradd -ms /bin/bash -d ${AIRFLOW_HOME} ${AIRFLOW_USER}

# Upgrade pip tooling
RUN pip install --upgrade pip setuptools wheel

# Step 1: install Airflow with the official constraint file
#         (the 3.13 file is missing the FAB pin — that's expected)
RUN CONSTRAINT_URL="https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_VERSION}.txt" && \
    pip install "apache-airflow[amazon,postgres,celery,cncf.kubernetes]==${AIRFLOW_VERSION}" \
        --constraint "${CONSTRAINT_URL}"

# Step 2: install the FAB provider WITHOUT the constraint file
#         (constraint omits it; let pip resolve a compatible version)
RUN pip install "apache-airflow-providers-fab"

# Sanity check — fail the build early if Flask/connexion aren't importable
RUN python -c "import flask, connexion, airflow.providers.fab; print('ok')"

USER ${AIRFLOW_USER}
WORKDIR ${AIRFLOW_HOME}
EXPOSE 8080
CMD ["airflow", "api-server"]

```


```
# Step 2: install FAB and its transitive deps that the broken
#         constraint file failed to pull in
RUN pip install \
        "apache-airflow-providers-fab" \
        "connexion[flask]" \
        "flask-appbuilder" \
        "flask-session<0.6.0"
```




```
ARG AIRFLOW_VERSION=3.2.0
ARG PYTHON_VERSION=3.13
ARG PYTHON_FULL_VERSION=3.13.12

FROM amazonlinux:2023

ARG AIRFLOW_VERSION
ARG PYTHON_VERSION
ARG PYTHON_FULL_VERSION

# ---------------------------------------------------------------------------
# System build dependencies
# ---------------------------------------------------------------------------
RUN dnf groupinstall -y "Development Tools" && \
    dnf install -y \
        gcc gcc-c++ make \
        openssl-devel bzip2-devel libffi-devel zlib-devel xz-devel \
        ncurses-devel readline-devel sqlite-devel tk-devel gdbm-devel \
        libpq-devel krb5-devel cyrus-sasl-devel libxml2-devel libxslt-devel \
        tar gzip wget which shadow-utils && \
    dnf clean all

# ---------------------------------------------------------------------------
# Build Python from source (AL2023 does not ship Python 3.13)
# ---------------------------------------------------------------------------
RUN cd /tmp && \
    wget -q "https://www.python.org/ftp/python/${PYTHON_FULL_VERSION}/Python-${PYTHON_FULL_VERSION}.tgz" && \
    tar xzf "Python-${PYTHON_FULL_VERSION}.tgz" && \
    cd "Python-${PYTHON_FULL_VERSION}" && \
    LDFLAGS="-Wl,-rpath=/usr/local/lib" \
    ./configure --enable-optimizations --enable-shared && \
    make -j "$(nproc)" && \
    make altinstall && \
    cd / && rm -rf /tmp/Python-*

RUN ln -sf /usr/local/bin/python${PYTHON_VERSION} /usr/local/bin/python3 && \
    ln -sf /usr/local/bin/python${PYTHON_VERSION} /usr/local/bin/python  && \
    ln -sf /usr/local/bin/pip${PYTHON_VERSION}     /usr/local/bin/pip3   && \
    ln -sf /usr/local/bin/pip${PYTHON_VERSION}     /usr/local/bin/pip

# ---------------------------------------------------------------------------
# Create non-root airflow user
# ---------------------------------------------------------------------------
RUN useradd -m -d /opt/airflow -s /bin/bash airflow

# ---------------------------------------------------------------------------
# Upgrade pip toolchain
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# ---------------------------------------------------------------------------
# Install Airflow with Python 3.13 constraints (FAB is included in 3.2.0+)
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "apache-airflow[amazon,postgres,celery,cncf.kubernetes]==${AIRFLOW_VERSION}" \
    "apache-airflow-providers-fab" \
    --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_VERSION}.txt"

# ---------------------------------------------------------------------------
# Remove dev-only manifests shipped in the FAB provider package.
# pnpm-lock.yaml references flatted and lodash as transitive devDependencies
# of webpack/eslint — they are not in the runtime JS bundles, but image
# scanners flag the lockfile. Safe to delete.
# ---------------------------------------------------------------------------
RUN rm -f /usr/local/lib/python3.13/site-packages/airflow/providers/fab/www/pnpm-lock.yaml \
          /usr/local/lib/python3.13/site-packages/airflow/providers/fab/www/package.json

# ---------------------------------------------------------------------------
# Sanity check — fail the build fast if key imports are missing
# ---------------------------------------------------------------------------
RUN python -c "\
import flask, flask_appbuilder, flask_login, flask_session; \
from airflow.providers.fab.auth_manager.fab_auth_manager import FabAuthManager; \
print('ok')"

# ---------------------------------------------------------------------------
# Runtime configuration
# ---------------------------------------------------------------------------
ENV AIRFLOW_HOME=/opt/airflow
WORKDIR /opt/airflow
USER airflow
EXPOSE 8080
CMD ["airflow", "api-server"]

```
```
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/aquasecurity/trivy:latest image airflow-3.2.0-py3.13
That mounts your Docker socket so Trivy can access local images. Useful flags:

--severity CRITICAL,HIGH — only show critical/high
--scanners vuln — skip misconfig/secret scanning, just vulnerabilities
--format table (default) or --format json for machine-readable output
--ignore-unfixed — hide CVEs with no available fix
Full example:


docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/aquasecurity/trivy:latest image \
  --severity CRITICAL,HIGH \
  --scanners vuln \
  airflow-3.2.0-py3.13
```

```
RUN rm -rf /usr/local/lib/python3.13/site-packages/flask_appbuilder/static/appbuilder/js/swagger-ui*
```

```
docker run --rm --entrypoint bash airflow-3.2.0-py3.13 -c "
echo '=== Searching for flatted/lodash files ==='
find / -iname '*flatted*' -o -iname '*lodash*' 2>/dev/null

echo ''
echo '=== Searching for lockfiles/package.json ==='
find / -name 'pnpm-lock.yaml' -o -name 'yarn.lock' -o -name 'package-lock.json' -o -name 'package.json' 2>/dev/null

echo ''
echo '=== Searching file contents for flatted/lodash ==='
grep -rl 'flatted\|lodash' /usr/local/lib/ 2>/dev/null || echo 'No matches found in /usr/local/lib/'

echo ''
echo '=== Checking node_modules ==='
find / -type d -name 'node_modules' 2>/dev/null || echo 'No node_modules directories found'
"
```
