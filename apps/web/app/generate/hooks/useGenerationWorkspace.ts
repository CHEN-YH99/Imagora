"use client";

import { useMemo, useReducer, type Dispatch, type SetStateAction } from "react";
import type { CreditAccount, GeneratedImage, SafetyAppeal, Task } from "../../../lib/api";

export type GenerationMessageTone = "info" | "success" | "danger";

export type GenerationWorkspaceState = {
  prompt: string;
  negativePrompt: string;
  selectedPresetId: string;
  aspectRatio: string;
  quantity: number;
  quantityInput: string;
  quality: string;
  model: string;
  quote: number;
  account: CreditAccount | null;
  task: Task | null;
  images: GeneratedImage[];
  selectedPreviewImage: GeneratedImage | null;
  message: string;
  messageTone: GenerationMessageTone;
  loading: boolean;
  activeGenerationTaskId: string | null;
  appealEventId: string | null;
  showAppealForm: boolean;
  appealReason: string;
  appealStatus: SafetyAppeal | null;
  appealLoading: boolean;
  restoringTaskView: boolean;
  advancedOpen: boolean;
};

export type GenerationWorkspaceInitialState = Pick<
  GenerationWorkspaceState,
  | "prompt"
  | "negativePrompt"
  | "selectedPresetId"
  | "aspectRatio"
  | "quantity"
  | "quality"
  | "model"
  | "activeGenerationTaskId"
  | "restoringTaskView"
>;

type FieldAction = {
  [Key in keyof GenerationWorkspaceState]: {
    type: "set-field";
    field: Key;
    value: SetStateAction<GenerationWorkspaceState[Key]>;
  };
}[keyof GenerationWorkspaceState];

export type GenerationWorkspaceAction =
  | FieldAction
  | { type: "apply-task-result"; result: { task: Task; images: GeneratedImage[] } }
  | { type: "begin-restore"; preserveVisibleState: boolean }
  | { type: "begin-submission" }
  | { type: "reset-appeal" };

export function createGenerationWorkspaceState(
  initial: GenerationWorkspaceInitialState
): GenerationWorkspaceState {
  return {
    ...initial,
    quantityInput: String(initial.quantity),
    quote: 0,
    account: null,
    task: null,
    images: [],
    selectedPreviewImage: null,
    message: "",
    messageTone: "danger",
    loading: false,
    appealEventId: null,
    showAppealForm: false,
    appealReason: "",
    appealStatus: null,
    appealLoading: false,
    advancedOpen: false
  };
}

export function generationWorkspaceReducer(
  state: GenerationWorkspaceState,
  action: GenerationWorkspaceAction
): GenerationWorkspaceState {
  switch (action.type) {
    case "set-field": {
      const currentValue = state[action.field];
      const nextValue =
        typeof action.value === "function"
          ? (action.value as (value: typeof currentValue) => typeof currentValue)(currentValue)
          : action.value;
      return { ...state, [action.field]: nextValue };
    }
    case "apply-task-result":
      return { ...state, task: action.result.task, images: action.result.images };
    case "begin-restore":
      return {
        ...state,
        loading: true,
        message: "",
        messageTone: "info",
        ...(action.preserveVisibleState
          ? {}
          : {
              task: null,
              images: [],
              selectedPreviewImage: null
            }),
        appealEventId: null,
        appealStatus: null,
        showAppealForm: false,
        appealReason: ""
      };
    case "begin-submission":
      return {
        ...state,
        loading: true,
        activeGenerationTaskId: null,
        message: "",
        messageTone: "danger",
        task: null,
        images: [],
        selectedPreviewImage: null,
        restoringTaskView: false,
        appealEventId: null,
        appealStatus: null,
        showAppealForm: false,
        appealReason: ""
      };
    case "reset-appeal":
      return {
        ...state,
        appealEventId: null,
        appealStatus: null,
        showAppealForm: false,
        appealReason: "",
        appealLoading: false
      };
    default:
      return state;
  }
}

type FieldSetter<Key extends keyof GenerationWorkspaceState> = Dispatch<SetStateAction<GenerationWorkspaceState[Key]>>;

type GenerationWorkspaceSetters = {
  [Key in keyof GenerationWorkspaceState as `set${Capitalize<Key>}`]: FieldSetter<Key>;
};

export type GenerationWorkspace = GenerationWorkspaceState &
  GenerationWorkspaceSetters & {
    applyTaskResult(result: { task: Task; images: GeneratedImage[] }): void;
    beginRestore(preserveVisibleState: boolean): void;
    beginSubmission(): void;
    resetAppeal(): void;
  };

function createSetters(dispatch: Dispatch<GenerationWorkspaceAction>): GenerationWorkspaceSetters {
  const setField = <Key extends keyof GenerationWorkspaceState>(field: Key): FieldSetter<Key> => (value) => {
    dispatch({ type: "set-field", field, value } as FieldAction);
  };

  return {
    setPrompt: setField("prompt"),
    setNegativePrompt: setField("negativePrompt"),
    setSelectedPresetId: setField("selectedPresetId"),
    setAspectRatio: setField("aspectRatio"),
    setQuantity: setField("quantity"),
    setQuantityInput: setField("quantityInput"),
    setQuality: setField("quality"),
    setModel: setField("model"),
    setQuote: setField("quote"),
    setAccount: setField("account"),
    setTask: setField("task"),
    setImages: setField("images"),
    setSelectedPreviewImage: setField("selectedPreviewImage"),
    setMessage: setField("message"),
    setMessageTone: setField("messageTone"),
    setLoading: setField("loading"),
    setActiveGenerationTaskId: setField("activeGenerationTaskId"),
    setAppealEventId: setField("appealEventId"),
    setShowAppealForm: setField("showAppealForm"),
    setAppealReason: setField("appealReason"),
    setAppealStatus: setField("appealStatus"),
    setAppealLoading: setField("appealLoading"),
    setRestoringTaskView: setField("restoringTaskView"),
    setAdvancedOpen: setField("advancedOpen")
  };
}

export function useGenerationWorkspace(initial: GenerationWorkspaceInitialState): GenerationWorkspace {
  const [state, dispatch] = useReducer(generationWorkspaceReducer, initial, createGenerationWorkspaceState);
  const setters = useMemo(() => createSetters(dispatch), [dispatch]);

  return {
    ...state,
    ...setters,
    applyTaskResult: (result) => dispatch({ type: "apply-task-result", result }),
    beginRestore: (preserveVisibleState) => dispatch({ type: "begin-restore", preserveVisibleState }),
    beginSubmission: () => dispatch({ type: "begin-submission" }),
    resetAppeal: () => dispatch({ type: "reset-appeal" })
  };
}
