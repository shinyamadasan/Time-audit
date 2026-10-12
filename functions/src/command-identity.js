// Pure command identity grammar shared by envelope, receipt and user-scoped domain guards.
export const ACTION_ID = /^act1_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const captureIdForAction = actionId => `bdc1_${actionId.slice(5)}`;
