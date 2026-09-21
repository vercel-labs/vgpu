import type { ChangeEvent, PointerEvent as ReactPointerEvent } from "react";

import type { PrismControls, PrismTheme } from "../../types";
import type { PrismPipelineQuality } from "../../pipelines/types";
import { useDebugControls } from "./control-context";
import { clampDebugRangeValue, controlGroupsForSource } from "./control-schema";
import type {
  DebugColorControl,
  DebugControl,
  DebugRangeControl,
  DebugSelectControl,
} from "./control-types";
import { ShadowCurvePreview } from "./shadow-curve-preview";

interface NodeControlsProps {
  readonly sourceId: string;
  readonly mode: PrismTheme;
  readonly quality: PrismPipelineQuality;
}

export function NodeControls({ sourceId, mode, quality }: NodeControlsProps) {
  const groups = controlGroupsForSource(sourceId, mode, quality);
  if (groups.length === 0) return null;
  return (
    <ControlGroups
      groups={groups}
      mode={mode}
      quality={quality}
      sourceId={sourceId}
    />
  );
}

interface ControlGroupsProps extends NodeControlsProps {
  readonly groups: ReturnType<typeof controlGroupsForSource>;
}

function ControlGroups({ groups, mode, sourceId }: ControlGroupsProps) {
  const { controls, updateControls } = useDebugControls();

  return (
    <div
      className="nodrag nopan prism-debug-node__controls"
      data-debug-controls={sourceId}
      onPointerDown={stopPropagation}
    >
      {groups.map((group) => (
        <fieldset key={group.label}>
          <legend>
            {group.label}
            {group.themeScoped ? <span>{mode}</span> : null}
          </legend>
          {group.preview === "shadowCurve" ? (
            <ShadowCurvePreview wall={controls.lightMode.wall} />
          ) : null}
          {group.controls.map((control) => (
            <Control
              key={control.id}
              control={control}
              controls={controls}
              mode={mode}
              onChange={(next) =>
                updateControls((current) =>
                  writeControl(control, current, mode, next)
                )
              }
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

interface ControlProps {
  readonly control: DebugControl;
  readonly controls: PrismControls;
  readonly mode: PrismTheme;
  onChange(value: number | string): void;
}

function Control(props: ControlProps) {
  switch (props.control.kind) {
    case "range":
      return <RangeControl {...props} control={props.control} />;
    case "select":
      return <SelectControl {...props} control={props.control} />;
    case "color":
      return <ColorControl {...props} control={props.control} />;
  }
}

function RangeControl({
  control,
  controls,
  mode,
  onChange,
}: ControlProps & {
  readonly control: DebugRangeControl;
}) {
  const value = control.read(controls, mode);
  const update = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next)) onChange(clampDebugRangeValue(control, next));
  };
  return (
    <label className="prism-debug-control" data-control-id={control.id}>
      <span>{control.label}</span>
      <input
        aria-label={control.label}
        max={control.max}
        min={control.min}
        onChange={update}
        step={control.step}
        type="range"
        value={value}
      />
      <input
        aria-label={`${control.label} value`}
        className="prism-debug-control__number"
        max={control.max}
        min={control.min}
        onChange={update}
        step={control.step}
        type="number"
        value={value}
      />
    </label>
  );
}

function SelectControl({
  control,
  controls,
  mode,
  onChange,
}: ControlProps & {
  readonly control: DebugSelectControl;
}) {
  return (
    <label className="prism-debug-control" data-control-id={control.id}>
      <span>{control.label}</span>
      <select
        aria-label={control.label}
        onChange={(event) => onChange(event.currentTarget.value)}
        value={control.read(controls, mode)}
      >
        {control.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColorControl({
  control,
  controls,
  mode,
  onChange,
}: ControlProps & {
  readonly control: DebugColorControl;
}) {
  const value = control.read(controls, mode);
  return (
    <label className="prism-debug-control" data-control-id={control.id}>
      <span>{control.label}</span>
      <input
        aria-label={control.label}
        onChange={(event) => onChange(event.currentTarget.value)}
        type="color"
        value={value}
      />
      <output>{value}</output>
    </label>
  );
}

function stopPropagation(event: ReactPointerEvent): void {
  event.stopPropagation();
}

function writeControl(
  control: DebugControl,
  controls: PrismControls,
  mode: PrismTheme,
  value: number | string
): PrismControls {
  switch (control.kind) {
    case "range":
      return control.write(controls, mode, Number(value));
    case "select":
    case "color":
      return control.write(controls, mode, String(value));
  }
}
