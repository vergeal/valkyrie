import dmLogo from "../assets/db/dm.png";
import mysqlLogo from "../assets/db/mysql.png";
import postgresqlLogo from "../assets/db/postgresql.png";
import redisLogo from "../assets/db/redis.png";
import sqliteLogo from "../assets/db/sqlite.png";
import { Icon } from "./icons";

/**
 * 各数据库的品牌 logo（沿用 FX 版内置的图标资源）。
 * 连接节点、连接下拉、连接管理器都用它，一眼就能看出连的是什么库。
 */
const LOGOS: Record<string, string> = {
  mysql: mysqlLogo,
  postgresql: postgresqlLogo,
  sqlite: sqliteLogo,
  redis: redisLogo,
  dm: dmLogo
};

/** 某个数据库类型的品牌 logo 资源地址（原生菜单拿它栅格化小图标） */
export function dbLogoUrl(type?: string): string | null {
  return LOGOS[(type ?? "").toLowerCase()] ?? null;
}

interface DbLogoProps {
  type?: string;
  size?: number;
  className?: string;
}

export function DbLogo({ type, size = 14, className }: DbLogoProps) {
  const src = LOGOS[(type ?? "").toLowerCase()];

  /* 没有对应 logo 的类型（或没填类型）退回通用数据库图标 */
  if (!src)
    return <Icon name="database" size={size} className={className} />;

  return (
    <img
      className={`db-logo${className ? ` ${className}` : ""}`}
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  );
}
