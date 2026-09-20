import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Drawer, Input, InputNumber, Radio, Select, Space, Switch, Tag, Typography } from "antd";
import { setSpecialistOptionsMode, updateSpecialistOptions } from "../api";
import { useLanguage } from "../language";
import type {
  RegisteredSpecialist,
  RegisteredSpecialistOption,
  SpecialistOptionValue,
  SpecialistOptionsMode
} from "../types";

type DraftValues = Record<string, SpecialistOptionValue>;

/**
 * Renders one form control per declared Specialist option and saves the whole
 * option object, so the server can validate it against the live schema.
 *
 * Options the author pinned (`editable === false`) are shown read-only with
 * their author default; options whose authority is `planner` are boundaries the
 * Planner resolves per Task rather than values the operator owns.
 */
export function SpecialistOptionsDrawer({ specialist, onClose, onSaved }: {
  specialist?: RegisteredSpecialist;
  onClose: () => void;
  onSaved?: (specialist: RegisteredSpecialist) => void;
}) {
  const { t } = useLanguage();
  const [draft, setDraft] = useState<DraftValues>({});
  const [saving, setSaving] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [error, setError] = useState<string>();
  const options = useMemo(() => specialist?.options ?? [], [specialist]);
  const editableOptions = useMemo(() => options.filter((option) => option.editable), [options]);

  useEffect(() => {
    if (!specialist) return;
    setDraft(Object.fromEntries(specialist.options.map((option) => [option.key, initialDraftValue(option)])));
    setError(undefined);
  }, [specialist]);

  const save = async (values: DraftValues) => {
    if (!specialist) return;
    setSaving(true);
    setError(undefined);
    try {
      // Author-fixed keys are never submitted: the server rejects a request that
      // tries to write one, and the UI must not pretend they are configurable.
      const body: DraftValues = {};
      for (const option of editableOptions) {
        const value = values[option.key];
        if (value !== undefined) body[option.key] = value;
      }
      const updated = await updateSpecialistOptions(specialist.id, body);
      onSaved?.(updated);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Mode changes apply immediately: the server re-normalizes every stored value
   * under the new authority, so waiting for "save" would show stale semantics.
   */
  const switchMode = async (mode: SpecialistOptionsMode | null) => {
    if (!specialist) return;
    setSwitchingMode(true);
    setError(undefined);
    try {
      // The API call must not sit inside the optional call: `onSaved?.(await ...)`
      // would skip it whenever no callback is supplied.
      const updated = await setSpecialistOptionsMode(specialist.id, mode);
      onSaved?.(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSwitchingMode(false);
    }
  };

  const authorModeLabel = specialist?.authorOptionsMode === "user"
    ? t("agents.optionsModeUser")
    : t("agents.optionsModePlanner");

  return (
    <Drawer
      open={Boolean(specialist)}
      size={520}
      title={`${t("agents.optionsTitle")} · ${specialist?.name ?? ""}`}
      onClose={onClose}
      destroyOnHidden
      footer={(
        <Space>
          <Button onClick={() => void save({})} disabled={saving} data-testid="specialist-options-reset">
            {t("agents.optionsReset")}
          </Button>
          <Button type="primary" loading={saving} onClick={() => void save(draft)}>
            {t("agents.optionsSave")}
          </Button>
        </Space>
      )}
    >
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {specialist ? (
        <div className="specialist-options-mode">
          <Space orientation="vertical" size={4}>
            <Space size={8} wrap>
              <Typography.Text strong>{t("agents.optionsMode")}</Typography.Text>
              <Radio.Group
                aria-label={t("agents.optionsMode")}
                optionType="button"
                disabled={saving || switchingMode}
                value={specialist.optionsMode}
                onChange={(event) => void switchMode(event.target.value as SpecialistOptionsMode)}
                options={[
                  { value: "planner", label: t("agents.optionsModePlanner") },
                  { value: "user", label: t("agents.optionsModeUser") }
                ]}
              />
              <Button
                size="small"
                loading={switchingMode}
                disabled={saving || switchingMode || specialist.optionsMode === specialist.authorOptionsMode}
                onClick={() => void switchMode(null)}
              >
                {t("agents.optionsModeReset")}
              </Button>
            </Space>
            <Typography.Text type="secondary">{t("agents.optionsModeHint")}</Typography.Text>
            <Space size={6} wrap>
              <Typography.Text type="secondary">
                {t("agents.optionsModeAuthorDefault", { value: authorModeLabel })}
              </Typography.Text>
              {specialist.optionsMode !== specialist.authorOptionsMode ? (
                <Tag color="gold">{t("agents.optionsModeOverridden")}</Tag>
              ) : null}
            </Space>
          </Space>
        </div>
      ) : null}
      {options.length === 0 ? (
        <Typography.Text type="secondary">{t("agents.optionsEmpty")}</Typography.Text>
      ) : (
        <div className="specialist-options-form">
          {options.map((option) => {
            const bounds = option.bounds ?? {};
            const minimum = bounds.minimum ?? option.spec.minimum;
            const maximum = bounds.maximum ?? option.spec.maximum;
            return (
              <div className="specialist-option-row" key={option.key}>
                <div className="specialist-option-label">
                  <Space size={6} wrap>
                    <Typography.Text strong>{option.spec.title}</Typography.Text>
                    {option.boundOnly ? <Tag color="blue">{t("agents.optionBoundCeiling")}</Tag> : null}
                    {option.editable ? null : <Tag>{t("agents.optionAuthorFixed")}</Tag>}
                  </Space>
                  <Typography.Text type="secondary" className="specialist-option-key">{option.key}</Typography.Text>
                  {option.spec.description ? <p>{option.spec.description}</p> : null}
                  {option.editable ? null : (
                    <Typography.Text type="secondary" className="specialist-option-author-default">
                      {t("agents.optionAuthorDefault", { value: formatOptionValue(option.authorDefault ?? option.value) })}
                    </Typography.Text>
                  )}
                  {option.editable && option.authority === "planner" && option.boundOnly ? (
                    <Typography.Text type="secondary" className="specialist-option-bound-hint">
                      {t("agents.optionPlannerNumberHint", {
                        minimum: minimum ?? 0,
                        maximum: maximum ?? t("agents.unbounded")
                      })}
                    </Typography.Text>
                  ) : null}
                  {option.editable && option.authority === "planner" && !option.boundOnly ? (
                    <Typography.Text type="secondary" className="specialist-option-bound-hint">
                      {t("agents.optionPlannerListHint", { value: (bounds.allowed ?? []).length })}
                    </Typography.Text>
                  ) : null}
                </div>
                {renderControl(
                  option,
                  draft[option.key],
                  (value) => setDraft((current) => ({ ...current, [option.key]: value })),
                  { disabled: !option.editable, minimum, maximum }
                )}
              </div>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}

/**
 * Starting draft for one option. A `planner` number stores a boundary rather
 * than a value, so the control starts at the effective ceiling: submitting it
 * unchanged keeps the author's range instead of narrowing it to the default.
 */
function initialDraftValue(option: RegisteredSpecialistOption): SpecialistOptionValue {
  if (option.authority === "planner" && option.boundOnly) {
    return option.bounds?.maximum ?? option.value;
  }
  return option.value;
}

function formatOptionValue(value: SpecialistOptionValue | undefined): string {
  if (value === undefined) return "-";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "-";
  if (value === "") return "-";
  return String(value);
}

function renderControl(
  option: RegisteredSpecialistOption,
  value: SpecialistOptionValue | undefined,
  onChange: (value: SpecialistOptionValue) => void,
  state: { disabled: boolean; minimum?: number; maximum?: number }
) {
  const spec = option.spec;
  switch (spec.type) {
    case "boolean":
      return (
        <Switch
          aria-label={option.key}
          disabled={state.disabled}
          checked={value === true}
          onChange={(checked) => onChange(checked)}
        />
      );
    case "number":
      return (
        <InputNumber
          aria-label={option.key}
          className="specialist-option-number"
          disabled={state.disabled}
          value={typeof value === "number" ? value : undefined}
          min={state.minimum}
          max={state.maximum}
          step={spec.integer === false ? 0.1 : 1}
          onChange={(next) => onChange(typeof next === "number" ? next : 0)}
        />
      );
    case "enum":
      return (
        <Select
          aria-label={option.key}
          disabled={state.disabled}
          value={typeof value === "string" ? value : undefined}
          options={spec.options ?? []}
          onChange={(next) => onChange(next)}
        />
      );
    case "string-list":
      return (
        <Select
          aria-label={option.key}
          mode="tags"
          disabled={state.disabled}
          value={Array.isArray(value) ? value : []}
          maxCount={spec.maxItems}
          onChange={(next: string[]) => onChange(next)}
        />
      );
    case "text":
      return (
        <Input.TextArea
          aria-label={option.key}
          rows={3}
          disabled={state.disabled}
          maxLength={spec.maxLength}
          placeholder={spec.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    default:
      return (
        <Input
          aria-label={option.key}
          disabled={state.disabled}
          maxLength={spec.maxLength}
          placeholder={spec.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}
