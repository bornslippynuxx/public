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
ARG AIRFLOW_VERSION=3.1.8
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
# Step A: Install Airflow with the (incomplete) Python 3.13 constraints
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "apache-airflow[amazon,postgres,celery,cncf.kubernetes]==${AIRFLOW_VERSION}" \
    --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_VERSION}.txt"

# ---------------------------------------------------------------------------
# Step B: FAB provider + Flask 2.x dependency tree — WORKAROUND
#
# The official constraints-3.13.txt for Airflow 3.1.8 is missing
# apache-airflow-providers-fab and its entire Flask 2.x transitive dependency
# tree. This causes the api-server to fail at startup with:
#
#   ModuleNotFoundError: No module named 'connexion'
#
# The packages themselves support Python 3.13 — only the constraint-file
# generation is broken. We pull the exact pins from the Python 3.12
# constraints file, which is known-good.
#
# Upstream issues:
#   https://github.com/apache/airflow/issues/57471
#   https://github.com/apache/airflow/issues/56123
#
# TODO: Remove this step once upstream ships a corrected constraints-3.13.txt.
# ---------------------------------------------------------------------------
RUN pip install --no-cache-dir \
    "apache-airflow-providers-fab==3.4.0" \
    "Flask==2.2.5" \
    "Werkzeug==2.2.3" \
    "Flask-AppBuilder==5.0.1" \
    "Flask-Babel==4.0.0" \
    "Flask-JWT-Extended==4.7.1" \
    "Flask-Login==0.6.3" \
    "Flask-Session==0.8.0" \
    "Flask-SQLAlchemy==3.1.1" \
    "Flask-WTF==1.2.2" \
    "WTForms==3.2.1" \
    "connexion[flask]==2.14.2" \
    "apispec==6.10.0" \
    "cachelib==0.13.0" \
    "clickclick==20.10.2" \
    "colorama==0.4.6" \
    "importlib_resources==6.5.2" \
    "jsonpickle==3.4.2" \
    "marshmallow-sqlalchemy==1.4.2" \
    "prison==0.2.1" \
    "cachetools==7.0.3"

# ---------------------------------------------------------------------------
# Sanity check — fail the build fast if key imports are missing
# ---------------------------------------------------------------------------
RUN python -c "\
import flask, connexion, flask_appbuilder, flask_login, flask_session; \
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
