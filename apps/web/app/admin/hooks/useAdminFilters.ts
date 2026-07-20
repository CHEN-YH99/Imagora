"use client";

import { useState } from "react";
import type { GeneratedImage, Order, SafetyAppeal, Task, User } from "../../../lib/api";

export function useAdminFilters() {
  const [taskStatusFilter, setTaskStatusFilter] = useState<"ALL" | Task["status"]>("ALL");
  const [orderStatusFilter, setOrderStatusFilter] = useState<"ALL" | Order["status"]>("ALL");
  const [imageVisibilityFilter, setImageVisibilityFilter] = useState<"ALL" | GeneratedImage["visibility"]>("ALL");
  const [safetyAppealStatusFilter, setSafetyAppealStatusFilter] = useState<"ALL" | SafetyAppeal["status"]>("ALL");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [orderNoFilter, setOrderNoFilter] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<"ALL" | User["status"]>("ALL");
  const [adminUserIdFilter, setAdminUserIdFilter] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [auditTargetTypeFilter, setAuditTargetTypeFilter] = useState("");
  const [auditTargetIdFilter, setAuditTargetIdFilter] = useState("");

  function resetEnterpriseFilters() {
    setCreatedFrom("");
    setCreatedTo("");
    setUserIdFilter("");
    setOrderNoFilter("");
  }

  return {
    taskStatusFilter,
    setTaskStatusFilter,
    orderStatusFilter,
    setOrderStatusFilter,
    imageVisibilityFilter,
    setImageVisibilityFilter,
    safetyAppealStatusFilter,
    setSafetyAppealStatusFilter,
    createdFrom,
    setCreatedFrom,
    createdTo,
    setCreatedTo,
    userIdFilter,
    setUserIdFilter,
    orderNoFilter,
    setOrderNoFilter,
    userSearch,
    setUserSearch,
    userStatusFilter,
    setUserStatusFilter,
    adminUserIdFilter,
    setAdminUserIdFilter,
    auditActionFilter,
    setAuditActionFilter,
    auditTargetTypeFilter,
    setAuditTargetTypeFilter,
    auditTargetIdFilter,
    setAuditTargetIdFilter,
    resetEnterpriseFilters
  };
}
