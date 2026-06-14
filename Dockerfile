FROM docker.n8n.io/n8nio/n8n:2.21.7

USER root

# The video workflows use require('node-fetch') from trusted Code nodes.
RUN cd /usr/local/lib/node_modules/n8n \
  && npm install --omit=dev --no-package-lock --no-save node-fetch@2.7.0 \
  && npm cache clean --force

COPY --chown=node:node n8n/ /opt/video-workflows/

USER node

EXPOSE 5678

