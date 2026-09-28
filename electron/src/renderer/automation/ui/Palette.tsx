import { AUTOMATION_DND_TYPE } from "./flowAdapter";
import { useAutomation } from "./context";
import { Icon } from "../../ui/icons";

export function Palette({ onAdd }: { onAdd: (type: string) => void }) {
  const { registry } = useAutomation();

  return (
    <aside className="am-palette">
      {registry.categories().map(category => {
        const items = registry.all().filter(definition => definition.manifest.category === category);

        return (
          <div className="am-palette-group" key={category}>
            <div className="am-palette-title">{category}</div>
            {items.map(definition => (
              <button
                key={definition.manifest.type}
                type="button"
                className="am-palette-item"
                draggable
                title={definition.manifest.description}
                onClick={() => onAdd(definition.manifest.type)}
                onDragStart={event => {
                  event.dataTransfer.setData(AUTOMATION_DND_TYPE, definition.manifest.type);
                  event.dataTransfer.effectAllowed = "move";
                }}
              >
                <span className="am-palette-dot" style={{ background: definition.manifest.color ?? "#6b7280" }} />
                {definition.manifest.icon && <Icon name={definition.manifest.icon} size={13} />}
                <span className="am-palette-label">{definition.manifest.title}</span>
              </button>
            ))}
          </div>
        );
      })}
    </aside>
  );
}
