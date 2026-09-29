//! Emits fixture bytes for the P1/P3 records using the struct definitions copied VERBATIM
//! (field order + types) from feat/p1-safety-release@6066399f `AssetRiskLimitsV17` and
//! feat/p3-vault-owned-lp `AssetVaultLpV18` / `VaultLpStateV18`, with offset_of! asserts
//! so the TS offsets are checked by rustc's repr(C) layout, not by hand.
use core::mem::{offset_of, size_of};
#[repr(C)] #[derive(Clone, Copy, Default)]
pub struct AssetRiskLimitsV17 { pub side_oi_cap_q: u128, pub lp_floor_atoms: u128, pub lp_exposure_k_bps: u32, pub exec_band_bps: u16, pub matcher_ext_mode: u8, pub _reserved0: u8, pub _reserved: [u8; 24] }
#[repr(C)] #[derive(Clone, Copy, Default)]
pub struct AssetVaultLpV18 { pub vault_lp_portfolio: [u8; 32], pub lp_net_q: i128, pub lev_cap_q: u128, pub lp_net_slot: u64, pub skew_slope_e9: u64, pub skew_max_e9: u64, pub lev_max_imr_bps: u16, pub flags: u8, pub _reserved0: [u8; 5], pub _reserved: [u8; 32] }
#[repr(C)] #[derive(Clone, Copy, Default)]
pub struct VaultLpStateV18 { pub market_group: [u8; 32], pub registry: [u8; 32], pub lp_portfolio: [u8; 32], pub junior_owner: [u8; 32], pub senior_claim_atoms: u128, pub junior_deposited_atoms: u128, pub junior_withdrawn_atoms: u128, pub senior_fee_credited_atoms: u128, pub recalled_atoms: u128, pub asset_index: u16, pub junior_floor_bps: u16, pub senior_fee_share_bps: u16, pub version: u8, pub bump: u8, pub _padding: [u8; 8], pub _reserved: [u8; 32] }
fn bytes<T: Copy>(t: &T) -> Vec<u8> { unsafe { core::slice::from_raw_parts(t as *const T as *const u8, size_of::<T>()).to_vec() } }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn main() {
    assert_eq!(size_of::<AssetRiskLimitsV17>(), 64);
    assert_eq!(size_of::<AssetVaultLpV18>(), 128);
    assert_eq!(size_of::<VaultLpStateV18>(), 256);
    let offs = [
        ("rl.side_oi_cap_q", offset_of!(AssetRiskLimitsV17, side_oi_cap_q)), ("rl.lp_floor_atoms", offset_of!(AssetRiskLimitsV17, lp_floor_atoms)),
        ("rl.lp_exposure_k_bps", offset_of!(AssetRiskLimitsV17, lp_exposure_k_bps)), ("rl.exec_band_bps", offset_of!(AssetRiskLimitsV17, exec_band_bps)),
        ("rl.matcher_ext_mode", offset_of!(AssetRiskLimitsV17, matcher_ext_mode)), ("rl._reserved0", offset_of!(AssetRiskLimitsV17, _reserved0)), ("rl._reserved", offset_of!(AssetRiskLimitsV17, _reserved)),
        ("av.lp_net_q", offset_of!(AssetVaultLpV18, lp_net_q)), ("av.lev_cap_q", offset_of!(AssetVaultLpV18, lev_cap_q)), ("av.lp_net_slot", offset_of!(AssetVaultLpV18, lp_net_slot)),
        ("av.skew_slope_e9", offset_of!(AssetVaultLpV18, skew_slope_e9)), ("av.skew_max_e9", offset_of!(AssetVaultLpV18, skew_max_e9)), ("av.lev_max_imr_bps", offset_of!(AssetVaultLpV18, lev_max_imr_bps)),
        ("av.flags", offset_of!(AssetVaultLpV18, flags)), ("av._reserved0", offset_of!(AssetVaultLpV18, _reserved0)), ("av._reserved", offset_of!(AssetVaultLpV18, _reserved)),
        ("vs.senior_claim_atoms", offset_of!(VaultLpStateV18, senior_claim_atoms)), ("vs.junior_deposited_atoms", offset_of!(VaultLpStateV18, junior_deposited_atoms)),
        ("vs.junior_withdrawn_atoms", offset_of!(VaultLpStateV18, junior_withdrawn_atoms)), ("vs.senior_fee_credited_atoms", offset_of!(VaultLpStateV18, senior_fee_credited_atoms)),
        ("vs.recalled_atoms", offset_of!(VaultLpStateV18, recalled_atoms)), ("vs.asset_index", offset_of!(VaultLpStateV18, asset_index)), ("vs.junior_floor_bps", offset_of!(VaultLpStateV18, junior_floor_bps)),
        ("vs.senior_fee_share_bps", offset_of!(VaultLpStateV18, senior_fee_share_bps)), ("vs.version", offset_of!(VaultLpStateV18, version)),
    ];
    let rl = AssetRiskLimitsV17 { side_oi_cap_q: 7_000_000_000, lp_floor_atoms: 250_000_000, lp_exposure_k_bps: 50_000, exec_band_bps: 300, matcher_ext_mode: 1, ..Default::default() };
    let mut key = [0u8; 32]; key[0] = 0xAB; key[31] = 0xCD;
    let av = AssetVaultLpV18 { vault_lp_portfolio: key, lp_net_q: -12_345_678_901, lev_cap_q: 40_000_000_000, lp_net_slot: 505_580_400, skew_slope_e9: 2_000, skew_max_e9: 900, lev_max_imr_bps: 5_000, flags: 1, ..Default::default() };
    let mut owner = [0u8; 32]; owner[0] = 7;
    let vs = VaultLpStateV18 { market_group: [1; 32], registry: [2; 32], lp_portfolio: key, junior_owner: owner, senior_claim_atoms: 1_000_000_000_000, junior_deposited_atoms: 150_000_000_000,
        junior_withdrawn_atoms: 10_000_000_000, senior_fee_credited_atoms: 3_210_000_000, recalled_atoms: 5, asset_index: 0, junior_floor_bps: 1_000, senior_fee_share_bps: 10_000, version: 1, bump: 254, ..Default::default() };
    let o: Vec<String> = offs.iter().map(|(n, v)| format!("\"{n}\":{v}")).collect();
    println!("{{\"offsets\":{{{}}},\"riskLimitsHex\":\"{}\",\"assetVaultLpHex\":\"{}\",\"vaultLpStateHex\":\"{}\"}}", o.join(","), hex(&bytes(&rl)), hex(&bytes(&av)), hex(&bytes(&vs)));
}
