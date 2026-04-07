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
