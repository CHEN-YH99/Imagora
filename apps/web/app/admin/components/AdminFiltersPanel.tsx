import type { Dispatch, SetStateAction } from "react";
import { Panel } from "../../../components/AppFrame";
import type { User } from "../../../lib/api";
import { Field } from "./AdminPrimitives";

type AdminFiltersPanelProps = {
  users: User[];
  createdFrom: string;
  setCreatedFrom: Dispatch<SetStateAction<string>>;
  createdTo: string;
  setCreatedTo: Dispatch<SetStateAction<string>>;
  userIdFilter: string;
  setUserIdFilter: Dispatch<SetStateAction<string>>;
  orderNoFilter: string;
  setOrderNoFilter: Dispatch<SetStateAction<string>>;
  onReset(): void;
};

export function AdminFiltersPanel({
  users,
  createdFrom,
  setCreatedFrom,
  createdTo,
  setCreatedTo,
  userIdFilter,
  setUserIdFilter,
  orderNoFilter,
  setOrderNoFilter,
  onReset
}: AdminFiltersPanelProps) {
  return (
    <Panel className="mt-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">组合筛选</h2>
        <button
          className="focus-ring rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-mint/70"
          onClick={onReset}
          type="button"
        >
          清空筛选
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="时间范围">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              type="datetime-local"
              value={createdFrom}
              onChange={(event) => setCreatedFrom(event.target.value)}
            />
            <input
              className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
              type="datetime-local"
              value={createdTo}
              onChange={(event) => setCreatedTo(event.target.value)}
            />
          </div>
        </Field>
        <Field label="用户筛选">
          <select
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            value={userIdFilter}
            onChange={(event) => setUserIdFilter(event.target.value)}
          >
            <option value="">全部用户</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.email}
              </option>
            ))}
          </select>
        </Field>
        <Field label="订单号筛选">
          <input
            autoComplete="off"
            className="focus-ring w-full rounded-full border border-white/12 bg-black/28 px-3 py-2 text-sm text-white"
            placeholder="输入订单号"
            type="search"
            value={orderNoFilter}
            onChange={(event) => setOrderNoFilter(event.target.value)}
          />
        </Field>
        <Field label="筛选说明">
          <p className="rounded-2xl border border-white/10 bg-black/20 px-4 py-2 text-sm text-white/60">
            时间和用户会同步作用于任务、图片和订单列表；订单号和订单状态只筛选订单列表。
          </p>
        </Field>
      </div>
    </Panel>
  );
}
