# Giskard Monitor — specialization image
#
# Bakes deployment-specific configuration (which API to talk to, instance label,
# poll cadence) on top of an already-built base image, so a single code artifact
# can be promoted into many environments as immutable, self-describing images.
#
#   docker build -f Dockerfile.spec --build-arg BASE_IMAGE=<base> \
#       --build-arg GISKARD_API_BASE=http://... -t <img>:<ver>-<spec> .

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG GISKARD_API_BASE=""
ARG GISKARD_API_TIMEOUT_MS=""
ARG INSTANCE_LABEL=""
ARG METRICS_POLL_MS=""
ARG LIVE_POLL_MS=""

ENV GISKARD_API_BASE=${GISKARD_API_BASE} \
    GISKARD_API_TIMEOUT_MS=${GISKARD_API_TIMEOUT_MS} \
    INSTANCE_LABEL=${INSTANCE_LABEL} \
    METRICS_POLL_MS=${METRICS_POLL_MS} \
    LIVE_POLL_MS=${LIVE_POLL_MS}
