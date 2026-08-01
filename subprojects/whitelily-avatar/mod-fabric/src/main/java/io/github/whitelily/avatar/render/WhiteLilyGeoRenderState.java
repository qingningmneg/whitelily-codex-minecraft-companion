package io.github.whitelily.avatar.render;

import io.github.whitelily.avatar.theme.ArmorTheme;
import java.util.IdentityHashMap;
import java.util.Map;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import org.jetbrains.annotations.Nullable;
import software.bernie.geckolib.constant.dataticket.DataTicket;
import software.bernie.geckolib.renderer.base.GeoRenderState;

public final class WhiteLilyGeoRenderState extends LivingEntityRenderState
    implements GeoRenderState {
  private final Map<DataTicket<?>, Object> geckoData = new IdentityHashMap<>();
  private ArmorTheme armorTheme = ArmorTheme.BASE;
  private WhiteLilyHeldItems heldItems;

  public ArmorTheme armorTheme() {
    return armorTheme;
  }

  public void setArmorTheme(ArmorTheme armorTheme) {
    this.armorTheme = armorTheme == null ? ArmorTheme.BASE : armorTheme;
  }

  WhiteLilyHeldItems heldItems() {
    return heldItems;
  }

  void setHeldItems(WhiteLilyHeldItems heldItems) {
    this.heldItems = heldItems;
  }

  @Override
  public <D> void addGeckolibData(DataTicket<D> dataTicket, @Nullable D data) {
    geckoData.put(dataTicket, data);
  }

  @Override
  public boolean hasGeckolibData(DataTicket<?> dataTicket) {
    return geckoData.containsKey(dataTicket);
  }

  @Nullable
  @Override
  @SuppressWarnings("unchecked")
  public <D> D getGeckolibData(DataTicket<D> dataTicket) {
    if (!geckoData.containsKey(dataTicket)) {
      throw new IllegalArgumentException("Missing GeckoLib render data");
    }
    return (D) geckoData.get(dataTicket);
  }

  @Override
  public Map<DataTicket<?>, Object> getDataMap() {
    return geckoData;
  }
}
