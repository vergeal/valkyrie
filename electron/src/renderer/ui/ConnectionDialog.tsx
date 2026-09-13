import { useMemo, useState } from "react";
import { chooseOpenPath, invoke, messageOf, type SavedConnection } from "../api";
import { DbLogo } from "./dbLogo";
import { Icon } from "./icons";
import { Dialog } from "./Dialog";
import { Select } from "./Select";

interface ConnectionDialogProps {
  mode: "new" | "edit" | "copy";
  source?: SavedConnection | null;
  /** 「新建连接 → 某种库」直接进来时的默认类型 */
  initialType?: string;
  onClose: () => void;
  /** 保存成功回调；connect = 用户点的是「保存并连接」 */
  onSaved: (name: string, options?: { connect?: boolean }) => void;
}

interface FormState {
  name: string;
  type: string;
  host: string;
  port: string;
  db: string;
  username: string;
  password: string;
  savePassword: boolean;
  sqlitePath: string;
  timezone: string;
  useSSL: boolean;
  tinyint1isBit: boolean;
  /** 高级：以文本框里的连接串为准，不用字段拼接 */
  customUrl: boolean;
  jdbcUrl: string;
  /** 高级：附加参数，形如 connectTimeout=5000&useUnicode=true */
  extraParams: string;
}

/** 连接类型预设：默认端口与说明（图标统一用各库的品牌 logo） */
export const DB_TYPES = [
  { value: "mysql", label: "MySQL", port: "3306", hint: "MySQL 5.7 / 8.x" },
  { value: "postgresql", label: "PostgreSQL", port: "5432", hint: "PostgreSQL 12 及以上" },
  { value: "sqlite", label: "SQLite", port: "", hint: "本地单文件数据库" },
  { value: "dm", label: "达梦数据库", port: "5236", hint: "DM8" },
  { value: "redis", label: "Redis", port: "6379", hint: "键值数据库" }
];

const TIMEZONES = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Tokyo", "UTC"];

const BASE_FORM: FormState = {
  name: "",
  type: "mysql",
  host: "127.0.0.1",
  port: "3306",
  db: "",
  username: "",
  password: "",
  savePassword: true,
  sqlitePath: "",
  timezone: "Asia/Shanghai",
  useSSL: false,
  tinyint1isBit: false,
  customUrl: false,
  jdbcUrl: "",
  extraParams: ""
};

function initialState(
  mode: ConnectionDialogProps["mode"],
  source?: SavedConnection | null,
  initialType?: string
): FormState {
  if (!source) {
    /* 「新建连接 → MySQL / Redis …」菜单进来时带上对应的默认端口 */
    const preset = DB_TYPES.find(item => item.value === initialType);

    return preset ? { ...BASE_FORM, type: preset.value, port: preset.port } : { ...BASE_FORM };
  }

  const restored: FormState = {
    ...BASE_FORM,
    name: mode === "copy" ? `${source.name} - 副本` : source.name,
    type: source.type || "mysql",
    host: source.host || "",
    port: source.port || "",
    db: source.db || "",
    username: source.username || "",
    password: source.password || "",
    savePassword: source.savePassword ?? true,
    sqlitePath: source.sqlitePath || "",
    timezone: source.timezone || "Asia/Shanghai",
    useSSL: source.useSSL ?? false,
    tinyint1isBit: source.tinyint1isBit ?? false,
    jdbcUrl: source.jdbcUrl || ""
  };

  /*
   * 老配置里存着连接串，若和按当前字段拼出来的结果不一致，
   * 说明它被手工改过 → 原样保留为「自定义连接串」，不做静默改写。
   */
  const customUrl = Boolean(source.jdbcUrl) && source.jdbcUrl !== buildUrl(restored);

  return { ...restored, customUrl };
}

/** 附加参数文本 → 键值对（容忍用户带上前后的 ? 或 &） */
function extraQuery(text: string): URLSearchParams {
  const params = new URLSearchParams();

  for (const pair of text.split("&")) {
    const entry = pair.trim().replace(/^[?&]/, "");

    if (!entry)
      continue;

    const at = entry.indexOf("=");
    params.set(at < 0 ? entry : entry.slice(0, at), at < 0 ? "" : entry.slice(at + 1));
  }

  return params;
}

function mergeQuery(base: URLSearchParams, extra: URLSearchParams): string {
  const merged = new URLSearchParams(base);

  extra.forEach((value, key) => merged.set(key, value));

  const text = merged.toString();
  return text ? `?${text}` : "";
}

/**
 * 按类型拼 JDBC URL：这里生成的串就是数据层实际用的连接串，
 * 每种数据库只带它自己认得的参数，避免把 MySQL 的参数塞给别的驱动。
 */
function buildUrl(form: FormState): string {
  const host = form.host.trim();
  const port = form.port.trim();
  const database = form.db.trim();

  if (form.type === "sqlite")
    return `jdbc:sqlite:${form.sqlitePath.trim()}`;

  if (form.type === "redis")
    return `jdbc:redis://${host}:${port}${database ? `/${database}` : ""}`;

  if (form.type === "postgresql") {
    /* PostgreSQL 只认 sslmode，没有 useSSL / 时区这类参数 */
    const params = new URLSearchParams();

    if (form.useSSL)
      params.set("sslmode", "require");

    return `jdbc:postgresql://${host}:${port}${database ? `/${database}` : ""}${mergeQuery(params, extraQuery(form.extraParams))}`;
  }

  if (form.type === "dm")
    return `jdbc:dm://${host}:${port}${database ? `/${database}` : ""}${mergeQuery(new URLSearchParams(), extraQuery(form.extraParams))}`;

  /* MySQL：时区 / SSL / TINYINT(1) 映射，另外带上字符集与公钥检索（MySQL 8 免装证书） */
  const params = new URLSearchParams();

  if (form.timezone)
    params.set("serverTimezone", form.timezone);

  params.set("useSSL", String(form.useSSL));
  params.set("tinyInt1isBit", String(form.tinyint1isBit));
  params.set("useUnicode", "true");
  params.set("characterEncoding", "UTF-8");
  params.set("allowPublicKeyRetrieval", "true");

  return `jdbc:mysql://${host}:${port}${database ? `/${database}` : ""}${mergeQuery(params, extraQuery(form.extraParams))}`;
}

/**
 * 连接编辑器：常规（连接名 / 类型 / 服务器 / 账号）+ 高级（参数、JDBC URL）。
 * 支持测试连接、保存、保存并连接；Enter 保存、Esc 关闭。
 */
export function ConnectionDialog({ mode, source, initialType, onClose, onSaved }: ConnectionDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialState(mode, source, initialType));
  const [tab, setTab] = useState<"general" | "advanced">("general");
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState<{ connect: boolean } | null>(null);
  const [reveal, setReveal] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const isSqlite = form.type === "sqlite";
  const preset = DB_TYPES.find(item => item.value === form.type) ?? DB_TYPES[0];
  const url = form.customUrl ? form.jdbcUrl : buildUrl(form);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(previous => ({ ...previous, [key]: value }));
    setStatus(null);
  }

  /* 字段校验：key → 错误文案 */
  const errors = useMemo(() => {
    const found: Partial<Record<keyof FormState, string>> = {};

    if (!form.name.trim())
      found.name = "连接名不能为空";

    if (isSqlite) {
      if (!form.sqlitePath.trim())
        found.sqlitePath = "请选择或填写数据库文件路径";
    } else {
      if (!form.host.trim())
        found.host = "主机不能为空";

      const port = Number(form.port);

      if (!form.port.trim())
        found.port = "端口不能为空";
      else if (!Number.isInteger(port) || port <= 0 || port > 65535)
        found.port = "端口需为 1 ~ 65535";
    }

    if (form.customUrl && !form.jdbcUrl.trim())
      found.jdbcUrl = "自定义连接串不能为空";

    return found;
  }, [form, isSqlite]);

  const invalid = Object.keys(errors).length > 0;
  const showError = (key: keyof FormState) => (submitted ? errors[key] : undefined);

  function payload(): SavedConnection {
    return {
      name: form.name.trim(),
      type: form.type,
      host: isSqlite ? undefined : form.host.trim(),
      port: isSqlite ? undefined : form.port.trim(),
      db: form.db.trim() || undefined,
      username: isSqlite ? undefined : form.username.trim() || undefined,
      password: form.password || undefined,
      savePassword: form.savePassword,
      sqlitePath: isSqlite ? form.sqlitePath.trim() : undefined,
      jdbcUrl: url,
      timezone: form.timezone,
      useSSL: form.useSSL,
      tinyint1isBit: form.tinyint1isBit
    };
  }

  async function testConnection() {
    setSubmitted(true);

    if (invalid) {
      setStatus({ text: "请先补全标红的必填项", ok: false });
      return;
    }

    setTesting(true);
    setStatus({ text: "正在连接…", ok: true });

    try {
      const opened = await invoke<{ sessionId: string; product: { productName?: string; version?: string } }>(
        "connection.open",
        { connection: payload() }
      );

      await invoke("connection.close", { sessionId: opened.sessionId }).catch(() => undefined);

      const product = `${opened.product?.productName ?? ""} ${opened.product?.version ?? ""}`.trim();
      setStatus({ text: product ? `连接成功 · ${product}` : "连接成功", ok: true });
    } catch (error) {
      setStatus({ text: messageOf(error), ok: false });
    } finally {
      setTesting(false);
    }
  }

  async function save(connect: boolean) {
    setSubmitted(true);

    if (invalid) {
      setStatus({ text: "请先修正表单中标红的内容", ok: false });

      if (errors.name || errors.host || errors.port || errors.sqlitePath)
        setTab("general");

      return;
    }

    setSaving({ connect });

    try {
      await invoke("connections.save", {
        connection: payload(),
        oldName: mode === "edit" ? source?.name : undefined
      });

      onSaved(form.name.trim(), { connect });
    } catch (error) {
      setStatus({ text: messageOf(error), ok: false });
    } finally {
      setSaving(null);
    }
  }

  async function browseSqliteFile() {
    const picked = await chooseOpenPath({
      title: "选择 SQLite 数据库文件",
      defaultPath: form.sqlitePath || undefined,
      filters: [
        { name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3", "db3"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });

    if (picked)
      update("sqlitePath", picked);
  }

  const title = mode === "new" ? "新建连接" : mode === "edit" ? "编辑连接" : "复制连接";
  const busy = testing || saving != null;

  return (
    <Dialog
      title={(
        <>
          <span className="conn-title-icon">
            <DbLogo type={form.type} size={16} />
          </span>
          {title}
        </>
      )}
      className="conn-dialog"
      onClose={onClose}
    >
      <div className="conn-tabs" role="tablist" aria-label="连接设置">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "general"}
          className={`conn-tab${tab === "general" ? " is-active" : ""}`}
          onClick={() => setTab("general")}
        >
          常规
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "advanced"}
          className={`conn-tab${tab === "advanced" ? " is-active" : ""}`}
          onClick={() => setTab("advanced")}
        >
          高级
          {invalid && submitted && <span className="conn-dot" aria-hidden="true" />}
        </button>
      </div>

      <div
        className="modal-body conn-body"
        onKeyDown={event => {
          const target = event.target as HTMLElement;

          if (event.key === "Enter" && target.tagName !== "TEXTAREA" && target.tagName !== "BUTTON") {
            event.preventDefault();
            void save(false);
          }
        }}
      >
        {tab === "general" ? (
          <>
            <section className="conn-section">
              <div className="conn-field">
                <label htmlFor="conn-name">连接名 <span className="conn-req">*</span></label>
                <input
                  id="conn-name"
                  value={form.name}
                  placeholder="例如：本地 MySQL"
                  aria-invalid={Boolean(showError("name"))}
                  onChange={event => update("name", event.target.value)}
                />
                <p className={`conn-hint${showError("name") ? " is-error" : ""}`}>
                  {showError("name") ?? "显示在对象导航里的名字"}
                </p>
              </div>

              <div className="conn-field">
                <label htmlFor="conn-type">类型 <span className="conn-req">*</span></label>
                <Select
                  id="conn-type"
                  logo={form.type}
                  value={form.type}
                  options={DB_TYPES.map(item => ({ value: item.value, label: item.label, logo: item.value }))}
                  onChange={type => {
                    const next = DB_TYPES.find(item => item.value === type);

                    setForm(previous => ({
                      ...previous,
                      type,
                      /* 端口跟着类型走；用户自己改过的端口不覆盖 */
                      port: previous.port === preset.port || !previous.port ? next?.port ?? "" : previous.port,
                      customUrl: false
                    }));
                    setStatus(null);
                  }}
                />
                <p className="conn-hint">{preset.hint}</p>
              </div>
            </section>

            <section className="conn-section">
              <h4 className="conn-section-title"><Icon name="server" size={13} />服务器</h4>

              {isSqlite ? (
                <div className="conn-field">
                  <label htmlFor="conn-path">数据库文件 <span className="conn-req">*</span></label>
                  <div className="conn-inline">
                    <input
                      id="conn-path"
                      className="mono"
                      value={form.sqlitePath}
                      placeholder="D:/data/demo.db"
                      aria-invalid={Boolean(showError("sqlitePath"))}
                      onChange={event => update("sqlitePath", event.target.value)}
                    />
                    <button type="button" className="mini-btn" onClick={() => void browseSqliteFile()}>
                      <Icon name="folderOpen" size={13} />浏览…
                    </button>
                  </div>
                  <p className={`conn-hint${showError("sqlitePath") ? " is-error" : ""}`}>
                    {showError("sqlitePath") ?? "文件不存在时会自动创建"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="conn-row">
                    <div className="conn-field">
                      <label htmlFor="conn-host">主机 / IP <span className="conn-req">*</span></label>
                      <input
                        id="conn-host"
                        value={form.host}
                        placeholder="127.0.0.1"
                        aria-invalid={Boolean(showError("host"))}
                        onChange={event => update("host", event.target.value)}
                      />
                      <p className={`conn-hint${showError("host") ? " is-error" : ""}`}>
                        {showError("host") ?? "支持域名或 IP"}
                      </p>
                    </div>

                    <div className="conn-field is-narrow">
                      <label htmlFor="conn-port">端口 <span className="conn-req">*</span></label>
                      <input
                        id="conn-port"
                        value={form.port}
                        placeholder={preset.port}
                        inputMode="numeric"
                        aria-invalid={Boolean(showError("port"))}
                        onChange={event => update("port", event.target.value)}
                      />
                      <p className={`conn-hint${showError("port") ? " is-error" : ""}`}>
                        {showError("port") ?? `默认 ${preset.port || "-"}`}
                      </p>
                    </div>
                  </div>

                  <div className="conn-field">
                    <label htmlFor="conn-db">{form.type === "redis" ? "默认库序号" : "默认数据库"}</label>
                    <input
                      id="conn-db"
                      value={form.db}
                      placeholder={form.type === "redis" ? "0" : "可留空，连接后再选"}
                      onChange={event => update("db", event.target.value)}
                    />
                    <p className="conn-hint">留空则使用服务器默认值</p>
                  </div>
                </>
              )}
            </section>

            {!isSqlite && (
              <section className="conn-section">
                <h4 className="conn-section-title"><Icon name="lock" size={13} />身份验证</h4>

                <div className="conn-field">
                  <label htmlFor="conn-user">{form.type === "redis" ? "用户名（Redis 忽略）" : "用户名"}</label>
                  <input
                    id="conn-user"
                    value={form.username}
                    placeholder={form.type === "redis" ? "留空即可" : "root"}
                    onChange={event => update("username", event.target.value)}
                  />
                </div>

                <div className="conn-field">
                  <label htmlFor="conn-password">密码</label>
                  <div className="conn-inline">
                    <input
                      id="conn-password"
                      type={reveal ? "text" : "password"}
                      value={form.password}
                      placeholder="密码"
                      onChange={event => update("password", event.target.value)}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={reveal ? "隐藏密码" : "显示密码"}
                      title={reveal ? "隐藏密码" : "显示密码"}
                      onClick={() => setReveal(value => !value)}
                    >
                      <Icon name={reveal ? "eyeOff" : "eye"} size={14} />
                    </button>
                  </div>
                </div>

                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={form.savePassword}
                    onChange={event => update("savePassword", event.target.checked)}
                  />
                  保存密码到本地配置
                </label>
              </section>
            )}
          </>
        ) : (
          <>
            <section className="conn-section">
              <h4 className="conn-section-title"><Icon name="sliders" size={13} />连接参数</h4>

              {form.type === "mysql" && (
                <div className="conn-field">
                  <label htmlFor="conn-timezone">时区</label>
                  <Select
                    id="conn-timezone"
                    icon="clock"
                    value={form.timezone}
                    options={TIMEZONES.map(zone => ({ value: zone, label: zone }))}
                    onChange={timezone => update("timezone", timezone)}
                  />
                  <p className="conn-hint">写入 serverTimezone，避免时间字段出现偏移</p>
                </div>
              )}

              {!isSqlite && form.type !== "redis" && (
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={form.useSSL}
                    onChange={event => update("useSSL", event.target.checked)}
                  />
                  使用 SSL 加密连接
                </label>
              )}

              {form.type === "mysql" && (
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={form.tinyint1isBit}
                    onChange={event => update("tinyint1isBit", event.target.checked)}
                  />
                  TINYINT(1) 映射为布尔值
                </label>
              )}

              {!isSqlite && form.type !== "redis" && (
                <div className="conn-field">
                  <label htmlFor="conn-extra">附加参数</label>
                  <input
                    id="conn-extra"
                    className="mono"
                    value={form.extraParams}
                    placeholder="connectTimeout=5000&useUnicode=true"
                    onChange={event => update("extraParams", event.target.value)}
                  />
                  <p className="conn-hint">按 key=value 追加到连接串，多个用 &amp; 分隔</p>
                </div>
              )}
            </section>

            <section className="conn-section">
              <h4 className="conn-section-title"><Icon name="code" size={13} />JDBC URL</h4>

              <label className="form-check">
                <input
                  type="checkbox"
                  checked={form.customUrl}
                  onChange={event => {
                    const on = event.target.checked;

                    setForm(previous => ({
                      ...previous,
                      customUrl: on,
                      /* 勾选时先把按字段拼好的串填进去，方便在此基础上改 */
                      jdbcUrl: on ? buildUrl(previous) : previous.jdbcUrl
                    }));
                    setStatus(null);
                  }}
                />
                自定义连接串（忽略上面的字段拼接结果）
              </label>

              <textarea
                className="conn-url mono"
                rows={3}
                readOnly={!form.customUrl}
                value={url}
                aria-label="JDBC URL"
                onChange={event => update("jdbcUrl", event.target.value)}
              />

              <div className="conn-inline">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => void navigator.clipboard?.writeText(url)}
                >
                  <Icon name="copy" size={13} />复制
                </button>
                {showError("jdbcUrl") && <span className="conn-hint is-error">{errors.jdbcUrl}</span>}
              </div>
            </section>
          </>
        )}
      </div>

      <div className="modal-status">
        {status
          ? (
            <span className={status.ok ? "is-ok" : "is-error"}>
              <Icon name={status.ok ? "ok" : "fail"} size={13} />
              {status.text}
            </span>
          )
          : <span className="is-muted">填好信息后可先「测试连接」，确认无误再保存</span>}
      </div>

      <div className="modal-actions">
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void testConnection()}>
          {testing ? "测试中…" : <><Icon name="plug" size={13} />测试连接</>}
        </button>
        <span className="modal-actions-push" />
        <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void save(false)}>
          {saving && !saving.connect ? "保存中…" : "保存"}
        </button>
        <button type="button" className="mini-btn is-default" disabled={busy} onClick={() => void save(true)}>
          {saving?.connect ? "连接中…" : "保存并连接"}
        </button>
      </div>
    </Dialog>
  );
}
