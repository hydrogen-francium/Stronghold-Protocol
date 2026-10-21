# 卫戍协议：盟约 · production image (server + static client). Docs: docs/DEPLOY.md「Docker」.
#
# 代码许可见 LICENSE；游戏素材不属于 GPL，版权及非商用限制见 NOTICE.md。
# 正式入口使用 compose.yaml；素材由独立初始化服务校验后只读挂载。
# 不再提供警告后继续的构建期素材下载，认证参数缺失仍由应用启动检查拒绝。
# 部署、迁移、维护与备份步骤见 docs/COMPOSE.md。

ARG NODE_IMAGE=node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c

# ---- 1. production dependencies (cached while package*.json are unchanged) -------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the postinstall (tools/vendor.mjs) runs in the next stage, once the sources are there
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- 2. 构建浏览器依赖；正式素材由独立初始化服务校验，不能警告后带缺失素材上线。 ----
FROM deps AS build
COPY shared ./shared
COPY server ./server
COPY tools ./tools
COPY data ./data
COPY public ./public
COPY plugins ./plugin-resources
COPY schemas ./schemas
COPY test/helpers/battleHarness.js ./test/helpers/battleHarness.js
COPY docs/PLUGIN*.md docs/plugin-catalog.example.json ./docs/
COPY docs/research ./docs/research
RUN node tools/vendor.mjs && rm -rf .cache

# ---- 3. runtime ---------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    SP_PLUGIN_RESOURCES=/app/plugin-resources
WORKDIR /app
COPY --from=deps /app/package.json ./package.json
# 运行镜像同样属于代码分发，必须保留项目和第三方许可声明。
COPY LICENSE NOTICE.md THIRD-PARTY-NOTICES.md ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/data ./data
COPY --from=build /app/public ./public
# the Spine and atlas parsers the plugin packer and the plugin studio use (server/plugins/pack.js, server/studio/)
COPY --from=build /app/tools/assets ./tools/assets
COPY --from=build /app/tools/plugin.mjs ./tools/plugin.mjs
COPY --from=build /app/tools/deploy/control.mjs ./tools/deploy/control.mjs
COPY --from=build /app/test/helpers/battleHarness.js ./test/helpers/battleHarness.js
COPY --from=build /app/schemas ./schemas
COPY --from=build /app/docs/PLUGIN*.md /app/docs/plugin-catalog.example.json ./docs/
# Root-owned templates and author guides remain visible when /app/plugins is a bind mount or named volume.
COPY --from=build /app/plugin-resources ./plugin-resources
RUN mkdir -p /app/plugins /app/.cache /srv/state && chown node:node /app/plugins /app/.cache /srv/state && chmod 0700 /srv/state
# research tables: read by server/sim/nodeData.js as a fallback
COPY --from=build /app/docs/research ./docs/research

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/healthz`); if (!r.ok || (await r.json()).ok !== true) process.exit(1)"]
CMD ["node", "server/index.js"]
