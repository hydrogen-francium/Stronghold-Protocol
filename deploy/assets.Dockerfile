# Python 与应用分离，下载包中的任何源码均不能影响初始化解释器。
FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
WORKDIR /bootstrap
COPY tools/deploy/init-assets.py ./tools/deploy/init-assets.py
COPY shared/asset-release.json ./shared/asset-release.json
RUN mkdir -p /srv/assets && chown 1000:1000 /srv/assets
USER 1000:1000
ENTRYPOINT ["python", "-I", "/bootstrap/tools/deploy/init-assets.py"]
CMD ["--root", "/srv/assets"]
