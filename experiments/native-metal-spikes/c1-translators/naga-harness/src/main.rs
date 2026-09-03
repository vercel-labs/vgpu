use naga::back::msl;
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::{AddressSpace, Module, ResourceBinding, StorageAccess, TypeInner};
use serde_json::json;
use std::env;
use std::fs;
use std::path::Path;

#[derive(Default)]
struct Slots {
    buffer: u8,
    texture: u8,
    sampler: u8,
}

fn binding_kind(module: &Module, variable: &naga::GlobalVariable) -> &'static str {
    match variable.space {
        AddressSpace::Uniform | AddressSpace::Storage { .. } => "buffer",
        AddressSpace::Handle => handle_kind(module, variable.ty),
        _ => "unsupported",
    }
}

fn handle_kind(module: &Module, ty: naga::Handle<naga::Type>) -> &'static str {
    match module.types[ty].inner {
        TypeInner::Image { .. } => "texture",
        TypeInner::Sampler { .. } => "sampler",
        TypeInner::BindingArray { base, .. } => handle_kind(module, base),
        _ => "unsupported",
    }
}

fn bind_target(kind: &str, mutable: bool, slots: &mut Slots) -> msl::BindTarget {
    match kind {
        "buffer" => {
            let slot = slots.buffer;
            slots.buffer += 1;
            msl::BindTarget {
                buffer: Some(slot),
                mutable,
                ..Default::default()
            }
        }
        "texture" => {
            let slot = slots.texture;
            slots.texture += 1;
            msl::BindTarget {
                texture: Some(slot),
                mutable,
                ..Default::default()
            }
        }
        "sampler" => {
            let slot = slots.sampler;
            slots.sampler += 1;
            msl::BindTarget {
                sampler: Some(msl::BindSamplerTarget::Resource(slot)),
                mutable,
                ..Default::default()
            }
        }
        _ => panic!("unsupported bound resource kind {kind}"),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err("usage: vgpu-c1-naga-harness <input.wgsl> <output.metal> <metadata.json>".into());
    }

    let source = fs::read_to_string(&args[1])?;
    let module = naga::front::wgsl::parse_str(&source)
        .map_err(|error| error.emit_to_string(&source))?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty())
        .validate(&module)
        .map_err(|error| error.emit_to_string(&source))?;

    // Metal has independent namespaces. Compact each one in stable WGSL binding order and
    // reserve buffer(30) for Naga's runtime-array length table.
    let mut resources: Vec<(ResourceBinding, &naga::GlobalVariable)> = module
        .global_variables
        .iter()
        .filter_map(|(_, variable)| variable.binding.clone().map(|binding| (binding, variable)))
        .collect();
    resources.sort_by_key(|(binding, _)| (binding.group, binding.binding));

    let mut slots = Slots::default();
    let mut binding_map = msl::BindingMap::default();
    let mut binding_metadata = Vec::new();
    for (binding, variable) in resources {
        let kind = binding_kind(&module, variable);
        let mutable = matches!(
            variable.space,
            AddressSpace::Storage { access } if access.contains(StorageAccess::STORE)
        );
        let target = bind_target(kind, mutable, &mut slots);
        binding_metadata.push(json!({
            "group": binding.group,
            "binding": binding.binding,
            "name": variable.name,
            "kind": kind,
            "buffer": target.buffer,
            "texture": target.texture,
            "sampler": match target.sampler {
                Some(msl::BindSamplerTarget::Resource(slot)) => Some(slot),
                _ => None,
            },
            "mutable": target.mutable,
        }));
        binding_map.insert(binding, target);
    }
    if slots.buffer > 30 {
        return Err(format!(
            "user buffer slots collide with reserved sizes buffer 30: {} buffers",
            slots.buffer
        )
        .into());
    }

    let mut per_entry_point_map = msl::EntryPointResourceMap::default();
    for entry in &module.entry_points {
        per_entry_point_map.insert(
            entry.name.clone(),
            msl::EntryPointResources {
                resources: binding_map.clone(),
                sizes_buffer: Some(30),
                immediates_buffer: None,
            },
        );
    }
    let options = msl::Options {
        lang_version: (2, 4),
        per_entry_point_map,
        fake_missing_bindings: false,
        ..Default::default()
    };
    let (msl_source, translation) =
        msl::write_string(&module, &info, &options, &msl::PipelineOptions::default())?;

    if let Some(parent) = Path::new(&args[2]).parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = Path::new(&args[3]).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args[2], &msl_source)?;

    let entries = module
        .entry_points
        .iter()
        .zip(translation.entry_point_names.iter())
        .map(|(entry, emitted)| {
            json!({
                "authoredName": entry.name,
                "emittedName": emitted.as_ref().ok(),
                "stage": format!("{:?}", entry.stage).to_lowercase(),
                "workgroupSize": entry.workgroup_size,
                "translationError": emitted.as_ref().err().map(ToString::to_string),
            })
        })
        .collect::<Vec<_>>();
    let metadata = json!({
        "translator": { "name": "naga", "version": "30.0.1" },
        "mslVersion": "2.4",
        "slotPolicy": "compact each Metal namespace independently by WGSL (group,binding); reserve buffer(30) for runtime-array sizes",
        "bindings": binding_metadata,
        "entryPoints": entries,
        "slotCounts": {
            "buffer": slots.buffer,
            "texture": slots.texture,
            "sampler": slots.sampler,
        },
    });
    fs::write(&args[3], format!("{}\n", serde_json::to_string_pretty(&metadata)?))?;
    Ok(())
}
