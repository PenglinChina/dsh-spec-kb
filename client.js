/**
 * dsh-spec-kb — browser half: the "Spec knowledge base" Settings section.
 *
 * Registers one `settings.section` page that lists the mounted stores, edits the
 * path list, browses the filesystem for a store directory, and saves through the
 * plugin's own `/api/spec-kb/*` routes.
 *
 * Hand-written module in the web client's module-table format: React comes from
 * the browser module table, so no build step or bundled React is involved.
 */
window.__ModuleLoader__.load({
  id: `dsh-spec-kb`,
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const NS = 'spec-kb'

    const en = {
      nav: 'Spec knowledge base',
      title: 'Spec knowledge base',
      intro:
        'Mount local standard spec-kb stores and make the agent consult the specification before answering questions they cover.',
      summary: 'Loads local standard spec-kb stores and makes the agent consult them first.',
      configured: 'Configured paths',
      defaults: 'Bundle defaults',
      sourceSettings: 'Saved from this page',
      sourceBundle: 'Bundle default',
      emptyPaths: 'No path configured yet. Add a store directory below.',
      addPlaceholder: 'Absolute path, e.g. F:/MyProject/spec-kb',
      add: 'Add',
      remove: 'Remove',
      browse: 'Browse…',
      save: 'Save',
      saving: 'Saving…',
      reset: 'Restore defaults',
      resetting: 'Restoring…',
      saved: 'Saved. The next tool call uses these stores.',
      resetDone: 'Restored the bundle defaults.',
      loaded: 'Loaded stores',
      loading: 'Reading the stores…',
      noStores: 'No store found under the configured paths.',
      entries: 'records',
      modules: 'modules',
      duplicates: 'duplicate ids',
      problems: 'Problems',
      close: 'Close',
      useDir: 'Use this folder',
      up: 'Up',
      storeTag: 'store',
      notStore: 'no store',
      loadFailed: 'Could not read the settings.',
      retry: 'Retry',
    }

    const zh = {
      nav: '规范知识库',
      title: '规范知识库',
      intro:
        '挂载本地的标准spec-kb 知识库；让智能体在回答和知识库相关的问题前先检索规范。',
      summary: '加载本地标准spec-kb 知识库，并让智能体优先查阅。',
      configured: '已配置路径',
      defaults: '插件默认路径',
      sourceSettings: '本页保存的配置',
      sourceBundle: '插件默认值',
      emptyPaths: '还没有配置路径，请在下方添加知识库目录。',
      addPlaceholder: '绝对路径，例如 F:/MyProject/spec-kb',
      add: '添加',
      remove: '移除',
      browse: '浏览…',
      save: '保存',
      saving: '正在保存…',
      reset: '恢复默认',
      resetting: '正在恢复…',
      saved: '已保存，下一次工具调用即使用新路径。',
      resetDone: '已恢复插件默认路径。',
      loaded: '已加载的知识库',
      loading: '正在读取知识库…',
      noStores: '配置的路径下没有发现知识库。',
      entries: '条记录',
      modules: '个模块',
      duplicates: '个重复 id',
      problems: '问题',
      close: '关闭',
      useDir: '使用此目录',
      up: '上一级',
      storeTag: '知识库',
      notStore: '无知识库',
      loadFailed: '读取设置失败。',
      retry: '重试',
    }

    const muted = { color: `var(--dsw-alias-fg-tertiary, #8a8f98)` }
    const border = `1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.32))`
    const panel = {
      background: `var(--dsw-alias-bg-secondary, rgba(128,128,128,0.07))`,
      border,
      borderRadius: 10,
      padding: 12,
    }
    const button = {
      border,
      background: `var(--dsw-alias-bg-primary, transparent)`,
      color: `inherit`,
      borderRadius: 8,
      padding: `5px 12px`,
      cursor: `pointer`,
      font: `inherit`,
      fontSize: 13,
    }
    const primaryButton = {
      ...button,
      border: `1px solid var(--dsw-alias-brand-primary, #2f6fed)`,
      background: `var(--dsw-alias-brand-primary, #2f6fed)`,
      color: `#fff`,
    }
    const input = {
      flex: 1,
      minWidth: 240,
      border,
      borderRadius: 8,
      padding: `6px 10px`,
      background: `var(--dsw-alias-bg-primary, transparent)`,
      color: `inherit`,
      font: `inherit`,
      fontSize: 13,
    }

    async function api(path, options) {
      const response = await fetch(path, {
        headers: { 'content-type': `application/json` },
        ...options,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    function StoreRow(props) {
      const { store, t } = props
      if (store.error) {
        return React.createElement(
          `div`,
          { style: { ...panel, borderColor: `var(--dsw-alias-fg-danger, #d03b3b)`, marginBottom: 8 } },
          React.createElement(`strong`, null, store.dir),
          React.createElement(`div`, { style: { ...muted, marginTop: 4 } }, store.error),
        )
      }
      return React.createElement(
        `div`,
        { style: { ...panel, marginBottom: 8 } },
        React.createElement(
          `div`,
          { style: { display: `flex`, gap: 8, alignItems: `baseline`, flexWrap: `wrap` } },
          React.createElement(`strong`, null, store.title || store.kb_id),
          React.createElement(`code`, { style: { ...muted, fontSize: 12 } }, store.kb_id),
          React.createElement(`span`, { style: { ...muted, fontSize: 12 } }, store.version),
        ),
        React.createElement(
          `div`,
          { style: { ...muted, fontSize: 12, marginTop: 4, wordBreak: `break-all` } },
          store.dir,
        ),
        React.createElement(
          `div`,
          { style: { display: `flex`, gap: 12, marginTop: 6, fontSize: 12, flexWrap: `wrap` } },
          React.createElement(`span`, null, `${store.entries} ${t(`entries`)}`),
          React.createElement(`span`, null, `${store.modules} ${t(`modules`)}`),
          store.duplicateRecords > 0
            ? React.createElement(
                `span`,
                { style: { color: `var(--dsw-alias-fg-warning, #b7791f)` } },
                `${store.duplicateRecords} ${t(`duplicates`)}`,
              )
            : null,
        ),
      )
    }

    function BrowsePanel(props) {
      const { browse, t, busy, onNavigate, onUp, onUse, onClose } = props
      return React.createElement(
        `div`,
        { style: { ...panel, marginTop: 10 } },
        React.createElement(
          `div`,
          { style: { display: `flex`, gap: 8, alignItems: `center`, flexWrap: `wrap` } },
          React.createElement(`code`, { style: { flex: 1, wordBreak: `break-all`, fontSize: 12 } }, browse.path),
          browse.parent
            ? React.createElement(`button`, { type: `button`, style: button, onClick: onUp, disabled: busy }, t(`up`))
            : null,
          React.createElement(`button`, { type: `button`, style: button, onClick: onClose }, t(`close`)),
        ),
        browse.error
          ? React.createElement(`div`, { style: { ...muted, marginTop: 8 } }, browse.error)
          : null,
        React.createElement(
          `div`,
          { style: { marginTop: 8, maxHeight: 220, overflow: `auto`, display: `flex`, flexDirection: `column`, gap: 2 } },
          (browse.directories ?? []).map((entry) =>
            React.createElement(
              `button`,
              {
                key: entry.name,
                type: `button`,
                onClick: () => onNavigate(browse.path === `/` ? `/${entry.name}` : `${browse.path.replace(/[\\/]+$/, ``)}/${entry.name}`),
                style: {
                  textAlign: `left`,
                  border: `none`,
                  background: `transparent`,
                  color: `inherit`,
                  cursor: `pointer`,
                  padding: `4px 6px`,
                  borderRadius: 6,
                  fontSize: 13,
                },
              },
              entry.name,
              entry.store
                ? React.createElement(`span`, { style: { ...muted, marginLeft: 8, fontSize: 11 } }, `● ${t(`storeTag`)}`)
                : React.createElement(`span`, { style: { ...muted, marginLeft: 8, fontSize: 11 } }, t(`notStore`)),
            ),
          ),
        ),
        React.createElement(
          `div`,
          { style: { marginTop: 8 } },
          React.createElement(`button`, { type: `button`, style: primaryButton, onClick: onUse, disabled: busy }, t(`useDir`)),
        ),
      )
    }

    function SpecKbSection(props) {
      const t = typeof props.t === `function` ? props.t : (key) => key
      const [status, setStatus] = React.useState(null)
      const [draft, setDraft] = React.useState([])
      const [inputValue, setInputValue] = React.useState(``)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [browse, setBrowse] = React.useState(null)

      const applyStatus = (next) => {
        setStatus(next)
        setDraft(Array.isArray(next.paths) ? next.paths : [])
      }

      const load = React.useCallback(async () => {
        setMessage(null)
        try {
          applyStatus(await api(`/api/spec-kb/status`))
        } catch (error) {
          setMessage({ kind: `error`, text: `${t(`loadFailed`)} ${error.message}` })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const addPath = (value) => {
        const text = String(value ?? ``).trim()
        if (text === ``) return
        setDraft((current) => (current.includes(text) ? current : [...current, text]))
        setInputValue(``)
      }

      const save = async () => {
        setBusy(true)
        setMessage(null)
        try {
          applyStatus(await api(`/api/spec-kb/paths`, { method: `POST`, body: JSON.stringify({ paths: draft }) }))
          setMessage({ kind: `ok`, text: t(`saved`) })
        } catch (error) {
          setMessage({ kind: `error`, text: error.message })
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        setBusy(true)
        setMessage(null)
        try {
          applyStatus(await api(`/api/spec-kb/reset`, { method: `POST`, body: `{}` }))
          setMessage({ kind: `ok`, text: t(`resetDone`) })
        } catch (error) {
          setMessage({ kind: `error`, text: error.message })
        } finally {
          setBusy(false)
        }
      }

      const browseTo = async (target) => {
        setBusy(true)
        try {
          const next = await api(`/api/spec-kb/browse?path=${encodeURIComponent(target ?? ``)}`)
          setBrowse(next)
        } catch (error) {
          setBrowse({ path: target ?? ``, error: error.message, directories: [] })
        } finally {
          setBusy(false)
        }
      }

      const openBrowse = () => browseTo(inputValue.trim() !== `` ? inputValue.trim() : draft[0] ?? ``)

      const useBrowsed = () => {
        if (browse && browse.ok) {
          addPath(browse.path)
          setBrowse(null)
        }
      }

      const sourceLabel = status?.source === `settings` ? t(`sourceSettings`) : t(`sourceBundle`)

      return React.createElement(
        `div`,
        { style: { display: `flex`, flexDirection: `column`, gap: 12, padding: `4px 2px 24px`, maxWidth: 780 } },
        React.createElement(`h2`, { style: { margin: 0, fontSize: 18 } }, t(`title`)),
        React.createElement(`p`, { style: { margin: 0, ...muted, lineHeight: 1.6 } }, t(`intro`)),

        message
          ? React.createElement(
              `div`,
              {
                style: {
                  ...panel,
                  borderColor:
                    message.kind === `error` ? `var(--dsw-alias-fg-danger, #d03b3b)` : `var(--dsw-alias-brand-primary, #2f6fed)`,
                  color: message.kind === `error` ? `var(--dsw-alias-fg-danger, #d03b3b)` : `inherit`,
                  padding: `8px 12px`,
                },
              },
              message.text,
            )
          : null,

        React.createElement(
          `div`,
          { style: { ...panel } },
          React.createElement(
            `div`,
            { style: { display: `flex`, justifyContent: `space-between`, gap: 8, flexWrap: `wrap`, marginBottom: 8 } },
            React.createElement(`strong`, null, t(`configured`)),
            React.createElement(`span`, { style: { ...muted, fontSize: 12 } }, sourceLabel),
          ),
          draft.length === 0
            ? React.createElement(`div`, { style: { ...muted, fontSize: 13, marginBottom: 8 } }, t(`emptyPaths`))
            : React.createElement(
                `div`,
                { style: { display: `flex`, flexDirection: `column`, gap: 4, marginBottom: 8 } },
                draft.map((path, index) =>
                  React.createElement(
                    `div`,
                    { key: `${path}-${index}`, style: { display: `flex`, gap: 8, alignItems: `center` } },
                    React.createElement(`code`, { style: { flex: 1, wordBreak: `break-all`, fontSize: 12 } }, path),
                    React.createElement(
                      `button`,
                      {
                        type: `button`,
                        style: button,
                        onClick: () => setDraft((current) => current.filter((_, i) => i !== index)),
                      },
                      t(`remove`),
                    ),
                  ),
                ),
              ),
          React.createElement(
            `div`,
            { style: { display: `flex`, gap: 8, flexWrap: `wrap`, alignItems: `center` } },
            React.createElement(`input`, {
              style: input,
              value: inputValue,
              placeholder: t(`addPlaceholder`),
              onChange: (event) => setInputValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === `Enter`) {
                  event.preventDefault()
                  addPath(inputValue)
                }
              },
            }),
            React.createElement(`button`, { type: `button`, style: button, onClick: () => addPath(inputValue) }, t(`add`)),
            React.createElement(`button`, { type: `button`, style: button, onClick: openBrowse, disabled: busy }, t(`browse`)),
          ),
          browse ? React.createElement(BrowsePanel, {
            browse,
            t,
            busy,
            onNavigate: browseTo,
            onUp: () => browseTo(browse.parent ?? ``),
            onUse: useBrowsed,
            onClose: () => setBrowse(null),
          }) : null,
          React.createElement(
            `div`,
            { style: { display: `flex`, gap: 8, marginTop: 10, flexWrap: `wrap` } },
            React.createElement(`button`, { type: `button`, style: primaryButton, onClick: save, disabled: busy }, busy ? t(`saving`) : t(`save`)),
            React.createElement(`button`, { type: `button`, style: button, onClick: reset, disabled: busy }, busy ? t(`resetting`) : t(`reset`)),
            status?.defaults?.length
              ? React.createElement(
                  `span`,
                  { style: { ...muted, fontSize: 12, alignSelf: `center` } },
                  `${t(`defaults`)}: ${status.defaults.join(`, `)}`,
                )
              : null,
          ),
        ),

        React.createElement(`h3`, { style: { margin: 0, fontSize: 15 } }, t(`loaded`)),
        status === null
          ? React.createElement(`div`, { style: { ...muted, fontSize: 13 } }, t(`loading`))
          : status.stores.length === 0
            ? React.createElement(`div`, { style: { ...muted, fontSize: 13 } }, t(`noStores`))
            : React.createElement(
                `div`,
                null,
                status.stores.map((store, index) => React.createElement(StoreRow, { key: `${store.kb_id ?? store.dir}-${index}`, store, t })),
              ),
        status?.problems?.length
          ? React.createElement(
              `div`,
              { style: { ...panel, borderColor: `var(--dsw-alias-fg-warning, #b7791f)` } },
              React.createElement(`strong`, null, t(`problems`)),
              React.createElement(
                `ul`,
                { style: { margin: `6px 0 0 18px`, padding: 0, fontSize: 12 } },
                status.problems.map((item) => React.createElement(`li`, { key: item }, item)),
              ),
            )
          : null,
        status === null
          ? React.createElement(`button`, { type: `button`, style: button, onClick: load }, t(`retry`))
          : null,
      )
    }

    const inject = [`slots`, `locale`]

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), `dsh-spec-kb: dictionaries`)
      ctx.effect(
        () =>
          ctx.slots.inject(`settings.section`, () =>
            ctx.slots.register(
              {
                name: `settings.section`,
                id: `spec-kb`,
                order: 60,
                label: () => t(`nav`),
                locale: NS,
              },
              SpecKbSection,
            ),
          ),
        `dsh-spec-kb: settings section`,
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
