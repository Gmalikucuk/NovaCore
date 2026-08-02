export interface SensitivityInput {
  itemNo: string
  quantity: number
  costPrice: number
  contractMargin: number
}

export interface SensitivityRow extends SensitivityInput {
  driftExposure: number
  overrunExposure: number
  combinedExposure: number
  exceedsMargin: boolean
}

/**
 * What a cost-drift-per-unit and a quantity-overrun-without-a-change-order
 * each cost across the contract, at tendered quantity. Both scale with
 * quantity, so both concentrate in the same few items concentrationByValue
 * surfaces. Overrun is modelled as cost incurred with NO revenue against it
 * — the unapproved-change-order case; where a change order exists, this
 * overstates the risk. See novacore_margin_exposure.jsx's "sensitivity" view.
 */
export function sensitivityExposure(
  items: readonly SensitivityInput[],
  costDriftPerUnit: number,
  overrunFraction: number,
): SensitivityRow[] {
  return items.map((item) => {
    const driftExposure = item.quantity * costDriftPerUnit
    const overrunExposure = item.quantity * overrunFraction * item.costPrice
    const combinedExposure = driftExposure + overrunExposure
    return {
      ...item,
      driftExposure,
      overrunExposure,
      combinedExposure,
      exceedsMargin: combinedExposure > item.contractMargin,
    }
  })
}
