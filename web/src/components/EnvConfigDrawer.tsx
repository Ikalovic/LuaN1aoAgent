import { useCallback, useRef } from "react";
import { Drawer } from "antd";
import { useLanguage } from "../language";
import { EnvConfigEditor } from "./EnvConfigEditor";

export function EnvConfigDrawer({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useLanguage();
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);

  return (
    <Drawer
      className="env-drawer"
      title={t("env.title")}
      open={open}
      onClose={() => { if (!dirty.current || window.confirm(t("env.unsavedConfirm"))) onClose(); }}
      size={760}
      destroyOnHidden
      maskClosable={false}
    >
      <EnvConfigEditor active={open} compact onSaved={onSaved} onDirtyChange={onDirtyChange} />
    </Drawer>
  );
}
