package io.github.whitelily.avatar.render;

import net.minecraft.world.entity.EntityType;
import software.bernie.geckolib.animatable.GeoReplacedEntity;
import software.bernie.geckolib.animatable.instance.AnimatableInstanceCache;
import software.bernie.geckolib.animatable.manager.AnimatableManager;
import software.bernie.geckolib.util.GeckoLibUtil;

public final class WhiteLilyAnimatable implements GeoReplacedEntity {
  private final AnimatableInstanceCache cache = GeckoLibUtil.createInstanceCache(this);

  @Override
  public EntityType<?> getReplacingEntityType() {
    return EntityType.PLAYER;
  }

  @Override
  public void registerControllers(AnimatableManager.ControllerRegistrar controllers) {
    // Task 7 owns animations. An empty registrar is GeckoLib's supported no-animation path.
  }

  @Override
  public AnimatableInstanceCache getAnimatableInstanceCache() {
    return cache;
  }
}
