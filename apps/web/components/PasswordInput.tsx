"use client";

import { type InputHTMLAttributes, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /**
   * 可选的额外类名，会拼接到默认输入框样式之后。
   */
  inputClassName?: string;
};

/**
 * 带"显示/隐藏"切换的密码输入框。
 * 抽成共享组件，避免登录/注册/重置多处复制 toggle 逻辑。
 */
export function PasswordInput({ inputClassName, ...inputProps }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const generatedId = useId();
  const inputId = inputProps.id ?? generatedId;

  return (
    <div className="relative mt-2">
      <input
        {...inputProps}
        id={inputId}
        type={visible ? "text" : "password"}
        className={`focus-ring w-full rounded-2xl border border-white/12 bg-black/28 px-4 py-3 pr-12 text-white ${inputClassName ?? ""}`}
      />
      <button
        aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible}
        className="focus-ring absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-2xl text-white/50 transition-colors duration-200 hover:text-white"
        onClick={() => setVisible((current) => !current)}
        tabIndex={-1}
        type="button"
      >
        {visible ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
      </button>
    </div>
  );
}
