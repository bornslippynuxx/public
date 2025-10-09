Here's how to build Option 3 step by step:

## Step 1: Inspect the Original Image

First, let's see what's in the mock-oauth2-server image:

```bash
docker pull ghcr.io/navikt/mock-oauth2-server:3.0.0
docker inspect ghcr.io/navikt/mock-oauth2-server:3.0.0
```

Check the entrypoint and working directory:
```bash
docker inspect ghcr.io/navikt/mock-oauth2-server:3.0.0 | grep -A 5 "Entrypoint\|WorkingDir\|Cmd"
```

## Step 2: Create the Dockerfile

Create a file named `Dockerfile`:

```dockerfile
FROM debian:12-slim

# Install Java 17 and update all packages including OpenSSL
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y openjdk-17-jre-headless ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy application files from the original image
COPY --from=ghcr.io/navikt/mock-oauth2-server:3.0.0 / /

# Set working directory (adjust if needed based on inspect results)
WORKDIR /app

# Expose port (mock-oauth2-server typically uses 8080)
EXPOSE 8080

# Use the same entrypoint as original image
# You'll need to adjust this based on the inspect output
ENTRYPOINT ["java", "-jar", "/app/mock-oauth2-server.jar"]
```

## Step 3: Find the Correct Entrypoint

Run a temporary container to explore the filesystem:

```bash
docker run --rm -it --entrypoint /bin/sh ghcr.io/navikt/mock-oauth2-server:3.0.0
```

Since distroless doesn't have a shell, try this instead:

```bash
# Save the image filesystem
docker create --name temp ghcr.io/navikt/mock-oauth2-server:3.0.0
docker export temp > mock-oauth2-server.tar
docker rm temp

# Extract and explore
mkdir extracted
tar -xf mock-oauth2-server.tar -C extracted
ls -la extracted/
find extracted/ -name "*.jar"
```

## Step 4: Update Dockerfile with Correct Paths

Based on what you find, update the Dockerfile. It likely looks something like:

```dockerfile
FROM debian:12-slim

# Install Java 17 and update all packages including OpenSSL
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y openjdk-17-jre-headless ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy the JAR and any config files
COPY --from=ghcr.io/navikt/mock-oauth2-server:3.0.0 /app /app

WORKDIR /app

EXPOSE 8080

# Adjust the JAR name based on what you found
ENTRYPOINT ["java", "-jar", "mock-oauth2-server.jar"]
```

## Step 5: Build Your Image

```bash
docker build -t mock-oauth2-server:3.0.0-patched .
```

## Step 6: Test the Image

```bash
docker run -p 8080:8080 mock-oauth2-server:3.0.0-patched
```

## Step 7: Verify OpenSSL is Updated

```bash
docker run --rm --entrypoint java mock-oauth2-server:3.0.0-patched -version
docker run --rm --entrypoint dpkg mock-oauth2-server:3.0.0-patched -l | grep openssl
```

## Step 8: Scan for Vulnerabilities

```bash
# Using Docker Scout
docker scout cves mock-oauth2-server:3.0.0-patched

# Or using Trivy
trivy image mock-oauth2-server:3.0.0-patched
```

**Need help with any of these steps?** Let me know what you find from the inspect command and I can refine the Dockerfile for you.
